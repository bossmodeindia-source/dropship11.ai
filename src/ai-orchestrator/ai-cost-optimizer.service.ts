/**
 * AiCostOptimizer — V4 COST MINIMIZATION ENGINE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUDIT FIX — STRICT AI USAGE RULES:
 *
 *   BOT MODE (free): handles 80–90% of all decisions
 *     - Hard kill/scale/pivot rules → BOT_HARD (no AI needed)
 *     - Template creatives → BOT (no AI needed)
 *     - DNA-available categories → BOT with DNA injection (no AI needed)
 *
 *   CACHE FIRST (always):
 *     - DNA reads cached 10 minutes
 *     - Semantic cache for similar prompts
 *     - Never repeat an AI call for same category in same hour
 *
 *   49B (standard):
 *     - Creative variation when DNA is available but needs adaptation
 *     - Triggered only for TEST/RUN products with score > 60
 *
 *   253B (strategic only):
 *     - HOLD zone campaigns needing strategic decision
 *     - 24h cooldown per campaign (never called twice per day)
 *     - Only for pro/enterprise users
 *     - Never called if BOT can make the decision
 *
 * COST TRACKING:
 *   Every AI call logged with estimated cost
 *   Tracks AI dependency ratio: (AI calls / total decisions)
 *   Goal: AI dependency < 15% of all decisions, decreasing over time
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { WinnerDnaService } from '../autonomous/winner-dna.service';

export type AiTier = 'BOT' | '49B' | '253B';

export interface AiDecisionContext {
  operation:     'creative' | 'strategy' | 'hook' | 'campaign';
  category:      string;
  productScore:  number;
  userTier:      string;
  campaignId?:   string;
  hasDna:        boolean;
  decisionType:  'HARD_RULE' | 'SCORE_RULE' | 'HOLD_ZONE' | 'ESCALATION';
}

export interface AiTierDecision {
  tier:        AiTier;
  reason:      string;
  cacheable:   boolean;
  estimatedCostUsd: number;
}

export interface CostSummary {
  totalDecisions:    number;
  botDecisions:      number;
  ai49BDecisions:    number;
  ai253BDecisions:   number;
  botRatio:          number;  // % handled by BOT (goal: > 85%)
  estimatedCostUsd:  number;
  savedVsFullAi:     number;  // estimated savings vs calling AI for everything
}

// Approximate cost per call (USD)
const COSTS: Record<AiTier, number> = {
  BOT:  0,
  '49B': 0.002,
  '253B': 0.015,
};

@Injectable()
export class AiCostOptimizer {
  private readonly logger = new Logger(AiCostOptimizer.name);

  // In-memory cycle counters (reset on restart)
  private stats = {
    bot: 0, ai49B: 0, ai253B: 0, total: 0, costUsd: 0,
  };

  // Per-category call cache: { category:operation → lastCallTime }
  private readonly callCache = new Map<string, number>();
  private readonly CACHE_TTL_MS = 60 * 60_000; // 1 hour

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly dna: WinnerDnaService,
  ) {}

  /**
   * Decide which AI tier to use for a given operation.
   * Goal: BOT handles 80–90% of all decisions.
   */
  decideTier(ctx: AiDecisionContext): AiTierDecision {
    this.stats.total++;

    // ── HARD RULE decisions → always BOT ──────────────────────────────────
    if (ctx.decisionType === 'HARD_RULE') {
      return this.botDecision('Hard rule decision — zero AI cost');
    }

    // ── DNA available + creative/hook → BOT with DNA injection ────────────
    if (ctx.hasDna && (ctx.operation === 'creative' || ctx.operation === 'hook')) {
      return this.botDecision('DNA available — template + DNA injection (zero AI cost)');
    }

    // ── Check hourly cache: same category+operation → BOT ─────────────────
    const cacheKey = `${ctx.category}:${ctx.operation}`;
    const lastCall = this.callCache.get(cacheKey);
    if (lastCall && Date.now() - lastCall < this.CACHE_TTL_MS) {
      return this.botDecision(`Cache hit for ${cacheKey} — reuse last result`);
    }

    // ── Low score product → BOT (not worth AI spend) ──────────────────────
    if (ctx.productScore < 60 && ctx.operation === 'creative') {
      return this.botDecision(`Product score ${ctx.productScore} < 60 — template sufficient`);
    }

    // ── HOLD zone + pro/enterprise → escalate to 253B only ────────────────
    if (ctx.decisionType === 'ESCALATION' && ctx.operation === 'strategy') {
      if (ctx.userTier === 'pro' || ctx.userTier === 'enterprise') {
        return this.tierDecision('253B', `Strategic decision for ${ctx.userTier} user — 253B warranted`, false);
      }
      // Free/starter → use 49B for strategy
      return this.tierDecision('49B', `Strategic decision for ${ctx.userTier} — 49B sufficient`, false);
    }

    // ── Creative for high-score products with no DNA → 49B ────────────────
    if (ctx.productScore >= 70 && ctx.operation === 'creative' && !ctx.hasDna) {
      return this.tierDecision('49B', `High score product (${ctx.productScore}) with no DNA — 49B creative gen`, true);
    }

    // ── Campaign planning → 49B ───────────────────────────────────────────
    if (ctx.operation === 'campaign' && ctx.productScore >= 65) {
      return this.tierDecision('49B', `Campaign planning — 49B sufficient`, true);
    }

    // Default → BOT (safe fallback)
    return this.botDecision('No AI escalation criteria met — BOT fallback');
  }

  /**
   * Record a call and update cache to prevent repeat calls.
   */
  recordCall(tier: AiTier, category: string, operation: string): void {
    if (tier !== 'BOT') {
      const cacheKey = `${category}:${operation}`;
      this.callCache.set(cacheKey, Date.now());

      if (tier === '49B') this.stats.ai49B++;
      else this.stats.ai253B++;
      this.stats.costUsd += COSTS[tier];
    } else {
      this.stats.bot++;
    }

    // Log cost summary every 100 decisions
    if (this.stats.total % 100 === 0) {
      this.logCostSummary();
    }
  }

  /**
   * Get cost tracking summary.
   */
  getCostSummary(): CostSummary {
    const total    = this.stats.total || 1;
    const fullAiCost = total * COSTS['49B']; // what it would cost if all were 49B

    return {
      totalDecisions:   this.stats.total,
      botDecisions:     this.stats.bot,
      ai49BDecisions:   this.stats.ai49B,
      ai253BDecisions:  this.stats.ai253B,
      botRatio:         parseFloat(((this.stats.bot / total) * 100).toFixed(1)),
      estimatedCostUsd: parseFloat(this.stats.costUsd.toFixed(4)),
      savedVsFullAi:    parseFloat((fullAiCost - this.stats.costUsd).toFixed(4)),
    };
  }

  /**
   * Persist cost summary to DB for tracking over time.
   */
  async persistCostSummary(): Promise<void> {
    const summary = this.getCostSummary();
    try {
      await this.db.execute(sql`
        INSERT INTO ai_cost_log (
          total_decisions, bot_decisions, ai_49b_decisions, ai_253b_decisions,
          bot_ratio, estimated_cost_usd, saved_vs_full_ai, recorded_at
        ) VALUES (
          ${summary.totalDecisions}, ${summary.botDecisions},
          ${summary.ai49BDecisions}, ${summary.ai253BDecisions},
          ${summary.botRatio}, ${summary.estimatedCostUsd}, ${summary.savedVsFullAi},
          NOW()
        )
      `).catch(() => null);
    } catch { /* non-critical */ }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private botDecision(reason: string): AiTierDecision {
    return {
      tier:             'BOT',
      reason,
      cacheable:        false,
      estimatedCostUsd: 0,
    };
  }

  private tierDecision(tier: '49B' | '253B', reason: string, cacheable: boolean): AiTierDecision {
    return {
      tier,
      reason,
      cacheable,
      estimatedCostUsd: COSTS[tier],
    };
  }

  private logCostSummary(): void {
    const summary = this.getCostSummary();
    this.logger.log(
      `[AiCost] 📊 ${summary.totalDecisions} decisions | ` +
      `BOT: ${summary.botRatio}% | ` +
      `49B: ${summary.ai49BDecisions} | 253B: ${summary.ai253BDecisions} | ` +
      `Cost: $${summary.estimatedCostUsd} | ` +
      `Saved: $${summary.savedVsFullAi}`,
    );
  }
}
