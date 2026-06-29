/**
 * ThompsonSamplingService — Multi-Armed Bandit for Creative Selection
 *
 * Uses Thompson Sampling (Bayesian bandit algorithm) to:
 *   1. Select which creative variant to show next (explore vs exploit)
 *   2. Update Beta distribution posteriors from observed CTR/ROAS data
 *   3. Identify winners early (before budget is wasted on losers)
 *   4. Automatically scale winners and pause losers
 *
 * Each creative arm has a Beta(α, β) distribution where:
 *   α = number of conversions (successes) + 1
 *   β = number of impressions without conversion (failures) + 1
 *
 * Arm is sampled by drawing from its Beta distribution.
 * The highest-sampled arm wins each round.
 *
 * Statistical significance:
 *   Declare winner when P(arm_i > all others) > 95% with N > 100 impressions.
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { Pool }                       from 'pg';
import { DB_POOL }                    from '../common/database/database.module';

export interface CreativeArm {
  armId:          string;  // creative / ad variant ID
  tenantId:       string;
  campaignId:     string;
  alpha:          number;  // successes + 1
  beta:           number;  // failures + 1
  impressions:    number;
  clicks:         number;
  conversions:    number;
  spend:          number;
  revenue:        number;
  ctr:            number;
  roas:           number;
  isActive:       boolean;
  isPaused:       boolean;
  isWinner:       boolean;
  createdAt:      Date;
  updatedAt:      Date;
}

export interface BanditResult {
  selectedArmId:   string;
  sampledValue:    number;
  allSamples:      Record<string, number>;
  explorationRate: number;
  isWinnerSelected: boolean;
}

export interface ArmUpdateInput {
  armId:       string;
  impressions: number;
  clicks:      number;
  conversions: number;
  spend:       number;
  revenue:     number;
}

@Injectable()
export class ThompsonSamplingService {
  private readonly logger = new Logger(ThompsonSamplingService.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  // ── Select next arm to show ───────────────────────────────────────────────
  async selectArm(campaignId: string, tenantId: string): Promise<BanditResult> {
    const arms = await this.getActiveArms(campaignId, tenantId);
    if (arms.length === 0) throw new Error(`No active arms for campaign ${campaignId}`);
    if (arms.length === 1) {
      return {
        selectedArmId:    arms[0]!.armId,
        sampledValue:     1.0,
        allSamples:       { [arms[0]!.armId]: 1.0 },
        explorationRate:  0,
        isWinnerSelected: arms[0]!.isWinner,
      };
    }

    // Sample from each arm's Beta distribution
    const samples: Record<string, number> = {};
    for (const arm of arms) {
      samples[arm.armId] = this.sampleBeta(arm.alpha, arm.beta);
    }

    // Select highest sample
    const selectedArmId = Object.entries(samples).sort(([,a],[,b]) => b - a)[0]![0];
    const selectedArm   = arms.find(a => a.armId === selectedArmId)!;

    return {
      selectedArmId,
      sampledValue:     samples[selectedArmId]!,
      allSamples:       samples,
      explorationRate:  this.computeExplorationRate(arms),
      isWinnerSelected: selectedArm.isWinner,
    };
  }

  // ── Update arm with new observation ──────────────────────────────────────
  async updateArm(input: ArmUpdateInput): Promise<void> {
    const { armId, impressions, clicks, conversions, spend, revenue } = input;

    await this.pool.query(
      `UPDATE creative_arms SET
         alpha       = alpha + $1,
         beta        = beta + $2,
         impressions = impressions + $3,
         clicks      = clicks + $4,
         conversions = conversions + $5,
         spend       = spend + $6,
         revenue     = revenue + $7,
         ctr         = CASE WHEN impressions + $3 > 0 THEN (clicks + $4)::float / (impressions + $3) ELSE 0 END,
         roas        = CASE WHEN spend + $6 > 0 THEN (revenue + $7) / (spend + $6) ELSE 0 END,
         updated_at  = NOW()
       WHERE arm_id = $8`,
      [conversions, impressions - conversions, impressions, clicks, conversions, spend, revenue, armId],
    );

    // Check for winner after update
    await this.checkAndDeclareWinner(armId);
  }

  // ── Register a new creative arm ───────────────────────────────────────────
  async registerArm(armId: string, campaignId: string, tenantId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO creative_arms (arm_id, campaign_id, tenant_id, alpha, beta, impressions, clicks, conversions, spend, revenue, ctr, roas, is_active, is_paused, is_winner, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 1, 0, 0, 0, 0, 0, 0, 0, true, false, false, NOW(), NOW())
       ON CONFLICT (arm_id) DO NOTHING`,
      [armId, campaignId, tenantId],
    );
  }

  // ── Pause a losing arm ────────────────────────────────────────────────────
  async pauseArm(armId: string): Promise<void> {
    await this.pool.query(
      `UPDATE creative_arms SET is_active = false, is_paused = true, updated_at = NOW() WHERE arm_id = $1`,
      [armId],
    );
    this.logger.log(`[Thompson] Paused losing arm: ${armId}`);
  }

  // ── Get arm statistics ────────────────────────────────────────────────────
  async getArmStats(campaignId: string, tenantId: string): Promise<CreativeArm[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM creative_arms WHERE campaign_id = $1 AND tenant_id = $2 ORDER BY roas DESC, ctr DESC`,
      [campaignId, tenantId],
    );
    return res.rows.map(this.mapRow);
  }

  // ── Private: check if we can declare a winner ─────────────────────────────
  private async checkAndDeclareWinner(armId: string): Promise<void> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM creative_arms WHERE campaign_id = (SELECT campaign_id FROM creative_arms WHERE arm_id = $1) AND is_active = true`,
      [armId],
    );
    const arms = res.rows.map(this.mapRow);
    if (arms.length < 2) return;

    // Require minimum impressions for statistical significance
    const qualified = arms.filter(a => a.impressions >= 100);
    if (qualified.length < 2) return;

    // Run 10,000 Monte Carlo simulations to find winner probability
    const winProbs = this.computeWinProbabilities(qualified, 10_000);

    for (const [id, prob] of Object.entries(winProbs)) {
      if (prob >= 0.95 && !qualified.find(a => a.armId === id)?.isWinner) {
        await this.pool.query(
          `UPDATE creative_arms SET is_winner = CASE WHEN arm_id = $1 THEN true ELSE false END, updated_at = NOW()
           WHERE campaign_id = (SELECT campaign_id FROM creative_arms WHERE arm_id = $1)`,
          [id],
        );
        this.logger.log(`[Thompson] Winner declared: arm ${id} (P=${(prob * 100).toFixed(1)}%)`);
      }
    }
  }

  // ── Monte Carlo win probability simulation ────────────────────────────────
  private computeWinProbabilities(arms: CreativeArm[], simulations: number): Record<string, number> {
    const wins: Record<string, number> = {};
    arms.forEach(a => wins[a.armId] = 0);

    for (let i = 0; i < simulations; i++) {
      let bestVal = -1;
      let bestId  = '';
      for (const arm of arms) {
        const sample = this.sampleBeta(arm.alpha, arm.beta);
        if (sample > bestVal) { bestVal = sample; bestId = arm.armId; }
      }
      wins[bestId] = (wins[bestId] ?? 0) + 1;
    }

    return Object.fromEntries(
      Object.entries(wins).map(([id, w]) => [id, w / simulations])
    );
  }

  // ── Sample from Beta(α, β) distribution using Gamma method ───────────────
  private sampleBeta(alpha: number, beta: number): number {
    const x = this.sampleGamma(alpha);
    const y = this.sampleGamma(beta);
    return x / (x + y);
  }

  // ── Sample from Gamma distribution (Marsaglia-Tsang method) ──────────────
  private sampleGamma(shape: number): number {
    if (shape < 1) {
      return this.sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number, v: number;
      do { x = this.standardNormal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  private standardNormal(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  private computeExplorationRate(arms: CreativeArm[]): number {
    const winner = arms.find(a => a.isWinner);
    if (winner) return 0.05; // 5% exploration after winner found
    const maxImpressions = Math.max(...arms.map(a => a.impressions));
    return Math.max(0.1, 1 - maxImpressions / 500); // reduce exploration as we get data
  }

  private async getActiveArms(campaignId: string, tenantId: string): Promise<CreativeArm[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM creative_arms WHERE campaign_id = $1 AND tenant_id = $2 AND is_active = true`,
      [campaignId, tenantId],
    );
    return res.rows.map(this.mapRow);
  }

  private mapRow = (row: Record<string, unknown>): CreativeArm => ({
    armId:       String(row['arm_id']),
    tenantId:    String(row['tenant_id']),
    campaignId:  String(row['campaign_id']),
    alpha:       Number(row['alpha']),
    beta:        Number(row['beta']),
    impressions: Number(row['impressions']),
    clicks:      Number(row['clicks']),
    conversions: Number(row['conversions']),
    spend:       Number(row['spend']),
    revenue:     Number(row['revenue']),
    ctr:         Number(row['ctr']),
    roas:        Number(row['roas']),
    isActive:    Boolean(row['is_active']),
    isPaused:    Boolean(row['is_paused']),
    isWinner:    Boolean(row['is_winner']),
    createdAt:   new Date(String(row['created_at'])),
    updatedAt:   new Date(String(row['updated_at'])),
  });
}
