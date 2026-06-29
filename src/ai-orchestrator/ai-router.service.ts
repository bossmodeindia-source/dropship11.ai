/**
 * AiRouter
 *
 * Stateless decision function: given facts about a request, output which
 * execution tier to use. All cost policy is enforced HERE — individual
 * services have zero discretion over model selection.
 *
 * Decision order (strict priority):
 *  1. Scoring              → always BOT (deterministic, no AI value)
 *  2. Quota exhausted      → BOT
 *  3. Circuit breaker open → BOT
 *  4. Strategy + spend≥$50 + no 24h cooldown → NVIDIA_253B
 *  5. Strategy (otherwise) → BOT (HOLD response)
 *  6. Premium user (pro/enterprise) → NVIDIA_49B
 *  7. High product score (≥65) → NVIDIA_49B
 *  8. Default → BOT
 *
 * 253B is NEVER routed in the HTTP request thread — the Orchestrator enqueues
 * those calls as background jobs and returns a jobId.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { CircuitBreakerService } from './circuit-breaker.service';
import { CooldownService } from './cooldown.service';
import { AiProviderRegistry } from './ai-provider.registry';

export type ExecutionTier = 'BOT' | 'NVIDIA_49B' | 'NVIDIA_253B';
export type SubscriptionTier = 'free' | 'starter' | 'pro' | 'enterprise';

export interface RoutingInput {
  operation:     string;
  productScore:  number;
  userTier:      SubscriptionTier;
  userId:        string;
  campaignSpend: number;
}

export interface RoutingDecision {
  tier:   ExecutionTier;
  reason: string;
}

const SCORE_THRESHOLD_FOR_49B   = 65;
const SPEND_THRESHOLD_FOR_253B  = 50;
const STRATEGY_253B_COOLDOWN_M  = 24 * 60; // 24 hours in minutes

@Injectable()
export class AiRouter {
  private readonly logger = new Logger(AiRouter.name);

  constructor(
    @Inject(DB_TOKEN)          private readonly db:       NodePgDatabase<typeof schema>,
    private readonly breaker:  CircuitBreakerService,
    private readonly cooldown: CooldownService,
    private readonly registry: AiProviderRegistry,
  ) {}

  async decide(input: RoutingInput): Promise<RoutingDecision> {
    // ── Rule 1: Scoring is always deterministic ────────────────────────────
    if (input.operation === 'scoring') {
      return this.route('BOT', 'scoring_is_deterministic');
    }

    // ── Rule 2: Quota gate ─────────────────────────────────────────────────
    const hasQuota = await this.checkQuota(input.userId);
    if (!hasQuota) {
      return this.route('BOT', 'quota_exhausted');
    }

    // ── Rule 3: Circuit breaker — all NVIDIA paths blocked ─────────────────
    let open49b = false;
    let open253b = false;
    try {
      [open49b, open253b] = await Promise.all([
        this.breaker.isOpen('nvidia_49b'),
        this.breaker.isOpen('nvidia_253b'),
      ]);
    } catch {
      // Redis unreachable — fail open (assume breakers closed, allow routing to proceed)
      this.logger.warn('[AiRouter] CircuitBreaker Redis error — failing open');
    }

    const nvidiaFullyDown = open49b && open253b;
    if (nvidiaFullyDown) {
      return this.route('BOT', 'circuit_breaker_open_all');
    }

    // ── Rule 4: Strategy — 253B gate ──────────────────────────────────────
    if (input.operation === 'strategy') {
      if (input.campaignSpend >= SPEND_THRESHOLD_FOR_253B) {
        // Spend threshold met — try to use 253B unless circuit is open or cooldown active
        if (!open253b) {
          const inCooldown = await this.cooldown.isInCooldown(
            input.userId,
            'strategy_253b',
            STRATEGY_253B_COOLDOWN_M,
          );
          if (!inCooldown) {
            const available = await this.registry.get253B().isAvailable();
            if (available) {
              return this.route('NVIDIA_253B', 'strategy_high_spend_no_cooldown');
            }
          }
        }
        return this.route('BOT', 'strategy_253b_unavailable_or_cooldown');
      }
      return this.route('BOT', 'strategy_insufficient_spend');
    }

    // ── Rule 5: 49B not available → BOT ───────────────────────────────────
    if (open49b) {
      return this.route('BOT', 'circuit_breaker_49b_open');
    }

    const nvidia49bAvailable = await this.registry.get49B().isAvailable();
    if (!nvidia49bAvailable) {
      return this.route('BOT', 'nvidia_49b_no_key');
    }

    // ── Rule 6: Premium users always get 49B ──────────────────────────────
    if (['pro', 'enterprise'].includes(input.userTier)) {
      return this.route('NVIDIA_49B', 'premium_user');
    }

    // ── Rule 7: High-potential product ────────────────────────────────────
    if (input.productScore >= SCORE_THRESHOLD_FOR_49B) {
      return this.route('NVIDIA_49B', 'high_score_product');
    }

    // ── Default: BOT ──────────────────────────────────────────────────────
    return this.route('BOT', 'default_bot_fallback');
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private route(tier: ExecutionTier, reason: string): RoutingDecision {
    this.logger.debug(`[Router] → ${tier} (${reason})`);
    return { tier, reason };
  }

  private async checkQuota(userId: string): Promise<boolean> {
    try {
      const sub = await this.db.query.subscriptions.findFirst({
        where: eq(schema.subscriptions.userId, userId),
      });
      if (!sub) return false;
      return sub.aiRequestsUsed < sub.aiRequestsLimit;
    } catch {
      return true; // DB down → don't block on quota
    }
  }
}
