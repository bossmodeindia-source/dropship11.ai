/**
 * AdvancedBanditEngine — V31 Requirement 6
 *
 * Req 6 — MULTI-ARMED BANDIT (ADVANCED):
 *   Allocates budget dynamically across THREE arm types simultaneously:
 *     - CAMPAIGN arms   (top-level campaign budget split)
 *     - CREATIVE arms   (per-campaign creative variant split)
 *     - PRODUCT arms    (per-campaign product mix split)
 *
 * Algorithm: Hierarchical Thompson Sampling
 *   Level 1: Campaign arms    → determines per-campaign budget envelope
 *   Level 2: Creative arms    → determines per-creative budget within campaign
 *   Level 3: Product arms     → determines per-product budget within campaign
 *
 * Reward signal:
 *   Win:  profit > 0  → alpha++
 *   Loss: profit ≤ 0  → beta++
 *   Neutral (no data): alpha=1 beta=1 (Laplace prior → equal probability)
 *
 * Exploration:
 *   EXPLORE_FRACTION of budget always goes to lowest-sample arms (cold-start protection)
 *   Explore arms rotate every EXPLORE_ROTATION_CYCLES
 *
 * State persistence:
 *   All arm states stored in pe_bandit_arms table (alpha, beta, last_reward_at)
 *   In-memory cache invalidated on reward signal or every CACHE_TTL_MS
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PROFIT_ENGINE_TOKENS } from './profit-engine.module';
import {
  BanditArmType,
  BanditArmState,
  MultiArmAllocation,
  MultiArmResult,
} from './profit-engine-types';

// ── Config ────────────────────────────────────────────────────────────────────
const EXPLORE_FRACTION        = parseFloat(process.env.BANDIT_EXPLORE_FRACTION    ?? '0.15');
const MIN_EXPLOIT_ARMS        = parseInt  (process.env.BANDIT_MIN_EXPLOIT_ARMS    ?? '1',    10);
const CACHE_TTL_MS            = parseInt  (process.env.BANDIT_CACHE_TTL_MS        ?? '120000', 10); // 2 min
const MAX_ARMS_PER_TYPE       = parseInt  (process.env.BANDIT_MAX_ARMS_PER_TYPE   ?? '20',   10);

@Injectable()
export class AdvancedBanditEngine {
  private readonly logger = new Logger(AdvancedBanditEngine.name);

  /** In-memory arm cache: armId → BanditArmState */
  private readonly cache = new Map<string, BanditArmState>();
  private cacheBuiltAt   = 0;

  constructor(
    @Inject(PROFIT_ENGINE_TOKENS.PG_POOL) private readonly pool: Pool,
  ) {}

  // ── Core allocation ───────────────────────────────────────────────────────

  /**
   * Run one Thompson Sampling step for ALL arm types.
   * Returns a flat list of allocations across campaigns, creatives, and products.
   *
   * @param totalBudget  Total budget to distribute (INR)
   * @param campaignIds  Active campaign IDs to include
   */
  async allocate(totalBudget: number, campaignIds: string[]): Promise<MultiArmResult> {
    await this.refreshCache();

    // ── Level 1: Campaign allocation ───────────────────────────────────────
    const campaignArms = campaignIds
      .map(id => this.getOrDefaultArm(id, 'CAMPAIGN'))
      .slice(0, MAX_ARMS_PER_TYPE);

    campaignArms.forEach(a => { a.sample = this.betaSample(a.alpha, a.beta); });
    campaignArms.sort((a, b) => b.sample - a.sample);

    const campaignBudgets = this.distributeByThompson(campaignArms, totalBudget);

    // ── Levels 2 & 3: Creative + Product allocation per campaign ──────────
    const allAllocations: MultiArmAllocation[] = [];
    const exploitArms: string[] = [];
    const exploreArms: string[] = [];

    for (const [i, arm] of campaignArms.entries()) {
      const campBudget = campaignBudgets.get(arm.armId) ?? 0;
      const isExplore  = i >= Math.max(MIN_EXPLOIT_ARMS, Math.ceil(campaignArms.length * (1 - EXPLORE_FRACTION)));

      allAllocations.push({
        armId:     arm.armId,
        armType:   'CAMPAIGN',
        budget:    campBudget,
        pct:       totalBudget > 0 ? campBudget / totalBudget : 0,
        isExplore,
        sample:    arm.sample,
      });

      if (isExplore) {
        exploreArms.push(arm.armId);
      } else {
        exploitArms.push(arm.armId);
      }

      // Level 2: Creatives for this campaign
      const creativeArms = await this.getChildArms(arm.armId, 'CREATIVE');
      if (creativeArms.length > 0) {
        const creativeBudgets = this.distributeByThompson(creativeArms, campBudget * 0.7);
        for (const ca of creativeArms) {
          allAllocations.push({
            armId:     ca.armId,
            armType:   'CREATIVE',
            budget:    creativeBudgets.get(ca.armId) ?? 0,
            pct:       campBudget > 0 ? (creativeBudgets.get(ca.armId) ?? 0) / campBudget : 0,
            isExplore: false,
            sample:    ca.sample,
          });
        }
      }

      // Level 3: Products for this campaign
      const productArms = await this.getChildArms(arm.armId, 'PRODUCT');
      if (productArms.length > 0) {
        const productBudgets = this.distributeByThompson(productArms, campBudget * 0.3);
        for (const pa of productArms) {
          allAllocations.push({
            armId:     pa.armId,
            armType:   'PRODUCT',
            budget:    productBudgets.get(pa.armId) ?? 0,
            pct:       campBudget > 0 ? (productBudgets.get(pa.armId) ?? 0) / campBudget : 0,
            isExplore: false,
            sample:    pa.sample,
          });
        }
      }
    }

    this.logger.log(
      `[AdvancedBandit] allocated: campaigns=${campaignArms.length} ` +
      `total_arms=${allAllocations.length} exploit=${exploitArms.length} explore=${exploreArms.length} ` +
      `budget=₹${totalBudget.toFixed(0)}`,
    );

    return { allocations: allAllocations, exploitArms, exploreArms, totalBudget };
  }

  // ── Reward signals ─────────────────────────────────────────────────────────

  /**
   * Record a reward (win/loss) for an arm.
   * win = profit > 0. Called after each execution cycle completes.
   */
  async reward(armId: string, armType: BanditArmType, win: boolean, parentId?: string): Promise<void> {
    const arm = this.getOrDefaultArm(armId, armType, parentId);
    if (win) {
      arm.alpha += 1;
    } else {
      arm.beta += 1;
    }
    this.cache.set(armId, arm);
    await this.persistArm(arm);
  }

  /**
   * Batch reward update — called at end of every execution batch.
   */
  async batchReward(
    rewards: Array<{ armId: string; armType: BanditArmType; win: boolean; parentId?: string }>,
  ): Promise<void> {
    await Promise.allSettled(rewards.map(r => this.reward(r.armId, r.armType, r.win, r.parentId)));
  }

  /**
   * Register a new arm (new campaign, creative, or product).
   * Uses Laplace prior (alpha=1, beta=1) → equal Thompson probability with all others.
   */
  async registerArm(armId: string, armType: BanditArmType, parentId?: string): Promise<void> {
    if (this.cache.has(armId)) return; // already registered

    const arm: BanditArmState = {
      armId,
      armType,
      parentId,
      alpha:  1,
      beta:   1,
      sample: 0.5,
      budget: 0,
      roi:    0,
    };
    this.cache.set(armId, arm);
    await this.persistArm(arm);
    this.logger.log(`[AdvancedBandit] registered new arm: ${armId} type=${armType}`);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Thompson-proportional budget distribution from a ranked arm list */
  private distributeByThompson(arms: BanditArmState[], totalBudget: number): Map<string, number> {
    const result = new Map<string, number>();
    if (arms.length === 0 || totalBudget <= 0) return result;

    const exploitCount = Math.max(MIN_EXPLOIT_ARMS, Math.ceil(arms.length * (1 - EXPLORE_FRACTION)));
    const exploitArms  = arms.slice(0, exploitCount);
    const exploreArms  = arms.slice(exploitCount);

    const exploitBudget = totalBudget * (1 - EXPLORE_FRACTION);
    const exploreBudget = totalBudget * EXPLORE_FRACTION;

    const sampleSum = exploitArms.reduce((s, a) => s + a.sample, 0);
    for (const arm of exploitArms) {
      result.set(arm.armId, sampleSum > 0 ? (arm.sample / sampleSum) * exploitBudget : exploitBudget / exploitArms.length);
    }
    if (exploreArms.length > 0) {
      const share = exploreBudget / exploreArms.length;
      for (const arm of exploreArms) result.set(arm.armId, share);
    }

    return result;
  }

  private getOrDefaultArm(armId: string, armType: BanditArmType, parentId?: string): BanditArmState {
    if (this.cache.has(armId)) return this.cache.get(armId)!;
    const arm: BanditArmState = { armId, armType, parentId, alpha: 1, beta: 1, sample: 0.5, budget: 0, roi: 0 };
    this.cache.set(armId, arm);
    return arm;
  }

  private async getChildArms(parentId: string, armType: BanditArmType): Promise<BanditArmState[]> {
    const cached = [...this.cache.values()].filter(a => a.parentId === parentId && a.armType === armType);
    if (cached.length > 0) {
      cached.forEach(a => { a.sample = this.betaSample(a.alpha, a.beta); });
      return cached.sort((a, b) => b.sample - a.sample);
    }
    // DB fallback
    try {
      const { rows } = await this.pool.query<any>(
        `SELECT arm_id, arm_type, parent_id, alpha, beta, roi, budget
         FROM pe_bandit_arms WHERE parent_id = $1 AND arm_type = $2 LIMIT $3`,
        [parentId, armType, MAX_ARMS_PER_TYPE],
      );
      return rows.map((r: any) => {
        const arm: BanditArmState = {
          armId:    r.arm_id,
          armType:  r.arm_type,
          parentId: r.parent_id,
          alpha:    Number(r.alpha),
          beta:     Number(r.beta),
          sample:   this.betaSample(Number(r.alpha), Number(r.beta)),
          budget:   Number(r.budget ?? 0),
          roi:      Number(r.roi ?? 0),
        };
        this.cache.set(arm.armId, arm);
        return arm;
      });
    } catch {
      return [];
    }
  }

  private async refreshCache(): Promise<void> {
    if (Date.now() - this.cacheBuiltAt < CACHE_TTL_MS) return;
    try {
      const { rows } = await this.pool.query<any>(
        `SELECT arm_id, arm_type, parent_id, alpha, beta, roi, budget
         FROM pe_bandit_arms WHERE arm_type = 'CAMPAIGN' ORDER BY alpha DESC LIMIT $1`,
        [MAX_ARMS_PER_TYPE * 5],
      );
      for (const r of rows) {
        this.cache.set(r.arm_id, {
          armId:    r.arm_id,
          armType:  r.arm_type as BanditArmType,
          parentId: r.parent_id,
          alpha:    Number(r.alpha),
          beta:     Number(r.beta),
          sample:   0,
          budget:   Number(r.budget ?? 0),
          roi:      Number(r.roi ?? 0),
        });
      }
      this.cacheBuiltAt = Date.now();
    } catch (e: any) {
      this.logger.warn(`[AdvancedBandit] cache refresh failed: ${e.message}`);
    }
  }

  private async persistArm(arm: BanditArmState): Promise<void> {
    await this.pool.query(
      `INSERT INTO pe_bandit_arms (arm_id, arm_type, parent_id, alpha, beta, roi, budget, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (arm_id) DO UPDATE SET
         alpha = EXCLUDED.alpha, beta = EXCLUDED.beta,
         roi = EXCLUDED.roi, budget = EXCLUDED.budget, updated_at = NOW()`,
      [arm.armId, arm.armType, arm.parentId ?? null, arm.alpha, arm.beta, arm.roi, arm.budget],
    ).catch(e => this.logger.warn(`Arm persist failed ${arm.armId}: ${e.message}`));
  }

  // ── Sampling math ─────────────────────────────────────────────────────────

  private betaSample(alpha: number, beta: number): number {
    const ga = this.gammaSample(alpha);
    const gb = this.gammaSample(beta);
    const t  = ga + gb;
    return t > 0 ? ga / t : 0.5;
  }

  private gammaSample(shape: number): number {
    if (shape < 1) return this.gammaSample(1 + shape) * Math.random() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do { x = this.normalSample(); v = 1 + c * x; } while (v <= 0);
      v = v ** 3;
      const u = Math.random();
      if (u < 1 - 0.0331 * x ** 4) return d * v;
      if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  private normalSample(): number {
    return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  }
}
