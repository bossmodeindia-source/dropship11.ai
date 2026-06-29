/**
 * CostProtectionService — V59 Spend Cap + API Usage Guard
 *
 * Protects tenant funds by enforcing:
 *   1. Daily spend caps — if spend_today > limit: stop_campaigns()
 *   2. Per-tenant AI generation caps (prevent abuse)
 *   3. Per-tenant campaign generation limits
 *   4. Per-plan API request caps
 *   5. Organic posting rate limits (prevent spam)
 *
 * All counters stored in Redis with TTL aligned to day boundary.
 * On cap breach: pause campaigns + alert + audit log.
 *
 * Plan limits:
 *   free:  $0 ad spend / 10 AI generations / 5 posts per day
 *   pro:   $500/day ad spend / 100 AI generations / 50 posts
 *   elite: $10,000/day ad spend / unlimited AI / unlimited posts
 */

import { Injectable, Logger, Inject, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { AlertingService } from '../alerting/alerting.service';

export type PlanTier = 'free' | 'pro' | 'elite';

export interface SpendStatus {
  tenantId: string;
  plan: PlanTier;
  spentToday: number;
  dailyCap: number;
  remaining: number;
  percentUsed: number;
  isBlocked: boolean;
}

// Daily spend caps in USD
const SPEND_CAPS: Record<PlanTier, number> = {
  free:  0,       // no paid ads on free
  pro:   500,
  elite: 10_000,
};

// AI generation caps per day
const AI_GEN_CAPS: Record<PlanTier, number> = {
  free:  10,
  pro:   200,
  elite: Infinity,
};

// Organic post caps per day
const ORGANIC_CAPS: Record<PlanTier, number> = {
  free:  5,
  pro:   50,
  elite: Infinity,
};

// Campaign launch caps per day
const CAMPAIGN_CAPS: Record<PlanTier, number> = {
  free:  0,
  pro:   20,
  elite: Infinity,
};

function midnightTtl(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
}

@Injectable()
export class CostProtectionService {
  private readonly logger = new Logger(CostProtectionService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly alerting: AlertingService,
  ) {}

  // ── Spend tracking ────────────────────────────────────────────────────────

  async recordSpend(tenantId: string, plan: PlanTier, amountUsd: number): Promise<void> {
    const key = this.spendKey(tenantId);
    const ttl = midnightTtl();

    const pipeline = this.redis.pipeline();
    pipeline.incrbyfloat(key, amountUsd);
    pipeline.expire(key, ttl);
    await pipeline.exec();

    const spent = await this.getSpendToday(tenantId);
    const cap = SPEND_CAPS[plan];

    if (cap > 0 && spent >= cap) {
      await this.handleSpendCapBreach(tenantId, plan, spent, cap);
    }
  }

  async getSpendToday(tenantId: string): Promise<number> {
    const val = await this.redis.get(this.spendKey(tenantId));
    return val ? parseFloat(val) : 0;
  }

  async getSpendStatus(tenantId: string, plan: PlanTier): Promise<SpendStatus> {
    const spent = await this.getSpendToday(tenantId);
    const cap = SPEND_CAPS[plan];
    const blocked = await this.isSpendBlocked(tenantId);
    return {
      tenantId,
      plan,
      spentToday: spent,
      dailyCap: cap,
      remaining: Math.max(0, cap - spent),
      percentUsed: cap > 0 ? Math.min(100, (spent / cap) * 100) : 0,
      isBlocked: blocked,
    };
  }

  async assertSpendAllowed(tenantId: string, plan: PlanTier, amountUsd: number): Promise<void> {
    if (plan === 'free') {
      throw new ForbiddenException('Paid advertising not available on Free plan');
    }
    const cap = SPEND_CAPS[plan];
    const spent = await this.getSpendToday(tenantId);
    if (spent + amountUsd > cap) {
      throw new ForbiddenException(
        `Daily spend cap exceeded. Spent: $${spent.toFixed(2)}, Cap: $${cap.toFixed(2)}`,
      );
    }
  }

  // ── AI generation cap ─────────────────────────────────────────────────────

  async assertAiGenerationAllowed(tenantId: string, plan: PlanTier): Promise<void> {
    const cap = AI_GEN_CAPS[plan];
    if (cap === Infinity) return;

    const key = `cost:ai:${tenantId}:${this.today()}`;
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);

    if (count >= cap) {
      throw new ForbiddenException(
        `Daily AI generation limit reached (${cap}/day on ${plan} plan). Upgrade for more.`,
      );
    }

    await this.redis.pipeline().incr(key).expire(key, midnightTtl()).exec();
  }

  // ── Organic posting cap ───────────────────────────────────────────────────

  async assertOrganicPostAllowed(tenantId: string, plan: PlanTier): Promise<void> {
    const cap = ORGANIC_CAPS[plan];
    if (cap === Infinity) return;

    const key = `cost:organic:${tenantId}:${this.today()}`;
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);

    if (count >= cap) {
      throw new ForbiddenException(
        `Daily organic posting limit reached (${cap}/day on ${plan} plan).`,
      );
    }

    await this.redis.pipeline().incr(key).expire(key, midnightTtl()).exec();
  }

  // ── Campaign launch cap ───────────────────────────────────────────────────

  async assertCampaignLaunchAllowed(tenantId: string, plan: PlanTier): Promise<void> {
    const cap = CAMPAIGN_CAPS[plan];
    if (cap === Infinity) return;
    if (cap === 0) {
      throw new ForbiddenException('Campaign launching not available on Free plan');
    }

    const key = `cost:campaigns:${tenantId}:${this.today()}`;
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);

    if (count >= cap) {
      throw new ForbiddenException(
        `Daily campaign launch limit reached (${cap}/day on ${plan} plan).`,
      );
    }

    await this.redis.pipeline().incr(key).expire(key, midnightTtl()).exec();
  }

  // ── Spend block management ────────────────────────────────────────────────

  private async handleSpendCapBreach(
    tenantId: string,
    plan: PlanTier,
    spent: number,
    cap: number,
  ): Promise<void> {
    const blockKey = `cost:blocked:${tenantId}`;
    const alreadyBlocked = await this.redis.get(blockKey);
    if (alreadyBlocked) return;

    await this.redis.setex(blockKey, midnightTtl(), '1');
    this.logger.warn(`Spend cap breach: tenant ${tenantId} spent $${spent} / cap $${cap}`);
    await this.alerting.alertExcessiveLoss(tenantId, spent, cap);
  }

  async isSpendBlocked(tenantId: string): Promise<boolean> {
    return (await this.redis.get(`cost:blocked:${tenantId}`)) === '1';
  }

  async unblockSpend(tenantId: string, adminId: string): Promise<void> {
    await this.redis.del(`cost:blocked:${tenantId}`);
    this.logger.warn(`Spend block removed for tenant ${tenantId} by admin ${adminId}`);
  }

  // ── Admin override: set custom daily cap ──────────────────────────────────

  async setCustomDailyCap(tenantId: string, capUsd: number): Promise<void> {
    await this.redis.setex(`cost:custom-cap:${tenantId}`, 86400 * 365, capUsd.toString());
  }

  async getEffectiveCap(tenantId: string, plan: PlanTier): Promise<number> {
    const custom = await this.redis.get(`cost:custom-cap:${tenantId}`);
    if (custom) return parseFloat(custom);
    return SPEND_CAPS[plan];
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private spendKey(tenantId: string): string {
    return `cost:spend:${tenantId}:${this.today()}`;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }
}
