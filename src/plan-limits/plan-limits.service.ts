/**
 * PlanLimitsService — V59 Plan-Based Feature Enforcement
 *
 * Enforces per-plan limits:
 *
 *   Free:
 *     - 1 bot max
 *     - organic posting only (no paid ads)
 *     - 10 AI generations/day
 *     - no A/B testing
 *     - no analytics export
 *
 *   Pro:
 *     - 5 bots max
 *     - paid + organic campaigns
 *     - 200 AI generations/day
 *     - A/B testing enabled
 *     - analytics export enabled
 *     - $500/day spend cap
 *
 *   Elite:
 *     - unlimited bots
 *     - all features
 *     - unlimited AI generations
 *     - advanced automation
 *     - $10,000/day spend cap
 *     - dedicated support
 *
 * Plan data cached in Redis (TTL 5 min) to avoid DB hammering.
 */

import {
  Injectable,
  Logger,
  Inject,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT } from "../common/redis/redis.module";
import { DB_TOKEN, DrizzleDB } from "../common/database/database.module";
import { sql } from "drizzle-orm";

export type PlanTier = 'free' | 'pro' | 'elite';

export interface PlanConfig {
  tier: PlanTier;
  maxBots: number;
  paidAdsEnabled: boolean;
  organicEnabled: boolean;
  abTestingEnabled: boolean;
  analyticsExport: boolean;
  dailySpendCapUsd: number;
  aiGenerationsPerDay: number;
  organicPostsPerDay: number;
  campaignLaunchesPerDay: number;
  advancedAutomation: boolean;
  multiStoreEnabled: boolean;
}

export const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
  free: {
    tier: 'free',
    maxBots: 1,
    paidAdsEnabled: false,
    organicEnabled: true,
    abTestingEnabled: false,
    analyticsExport: false,
    dailySpendCapUsd: 0,
    aiGenerationsPerDay: 10,
    organicPostsPerDay: 5,
    campaignLaunchesPerDay: 0,
    advancedAutomation: false,
    multiStoreEnabled: false,
  },
  pro: {
    tier: 'pro',
    maxBots: 5,
    paidAdsEnabled: true,
    organicEnabled: true,
    abTestingEnabled: true,
    analyticsExport: true,
    dailySpendCapUsd: 500,
    aiGenerationsPerDay: 200,
    organicPostsPerDay: 50,
    campaignLaunchesPerDay: 20,
    advancedAutomation: false,
    multiStoreEnabled: false,
  },
  elite: {
    tier: 'elite',
    maxBots: Infinity,
    paidAdsEnabled: true,
    organicEnabled: true,
    abTestingEnabled: true,
    analyticsExport: true,
    dailySpendCapUsd: 10_000,
    aiGenerationsPerDay: Infinity,
    organicPostsPerDay: Infinity,
    campaignLaunchesPerDay: Infinity,
    advancedAutomation: true,
    multiStoreEnabled: true,
  },
};

@Injectable()
export class PlanLimitsService {
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
  ) {}

  // ── Get tenant plan ───────────────────────────────────────────────────────

  async getTenantPlan(tenantId: string): Promise<PlanTier> {
    const cacheKey = `plan:${tenantId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached && ['free', 'pro', 'elite'].includes(cached)) {
      return cached as PlanTier;
    }

    const rows = await this.db.execute(sql`SELECT plan FROM tenants WHERE id = ${tenantId} LIMIT 1`);
    const plan = (rows.rows[0] as any)?.plan as PlanTier ?? 'free';
    await this.redis.setex(cacheKey, 300, plan); // cache 5 min
    return plan;
  }

  async getPlanConfig(tenantId: string): Promise<PlanConfig> {
    const plan = await this.getTenantPlan(tenantId);
    return PLAN_CONFIGS[plan];
  }

  // ── Assertion helpers (throw ForbiddenException on violation) ─────────────

  async assertBotLimitNotReached(tenantId: string): Promise<void> {
    const config = await this.getPlanConfig(tenantId);
    if (config.maxBots === Infinity) return;

    const rows = await this.db.execute(sql`SELECT COUNT(*) as count FROM bots WHERE tenant_id = ${tenantId} AND status != 'deleted'`);
    const current = parseInt((rows.rows[0] as any)?.count ?? '0', 10);
    if (current >= config.maxBots) {
      throw new ForbiddenException(
        `Bot limit reached (${config.maxBots} on ${config.tier} plan). ` +
        `Upgrade to Pro or Elite for more bots.`,
      );
    }
  }

  async assertPaidAdsAllowed(tenantId: string): Promise<void> {
    const config = await this.getPlanConfig(tenantId);
    if (!config.paidAdsEnabled) {
      throw new ForbiddenException(
        `Paid advertising requires Pro or Elite plan. Current plan: ${config.tier}`,
      );
    }
  }

  async assertOrganicAllowed(tenantId: string): Promise<void> {
    const config = await this.getPlanConfig(tenantId);
    if (!config.organicEnabled) {
      throw new ForbiddenException('Organic posting not available on current plan');
    }
  }

  async assertAbTestingAllowed(tenantId: string): Promise<void> {
    const config = await this.getPlanConfig(tenantId);
    if (!config.abTestingEnabled) {
      throw new ForbiddenException(
        `A/B testing requires Pro or Elite plan. Current plan: ${config.tier}`,
      );
    }
  }

  async assertAnalyticsExportAllowed(tenantId: string): Promise<void> {
    const config = await this.getPlanConfig(tenantId);
    if (!config.analyticsExport) {
      throw new ForbiddenException('Analytics export requires Pro or Elite plan');
    }
  }

  async assertAdvancedAutomationAllowed(tenantId: string): Promise<void> {
    const config = await this.getPlanConfig(tenantId);
    if (!config.advancedAutomation) {
      throw new ForbiddenException('Advanced automation requires Elite plan');
    }
  }

  async assertMultiStoreAllowed(tenantId: string): Promise<void> {
    const config = await this.getPlanConfig(tenantId);
    if (!config.multiStoreEnabled) {
      throw new ForbiddenException('Multi-store management requires Elite plan');
    }
  }

  // ── Invalidate plan cache (call after plan upgrade) ───────────────────────
  async invalidatePlanCache(tenantId: string): Promise<void> {
    await this.redis.del(`plan:${tenantId}`);
  }

  // ── Get all plan configs (for frontend feature gates) ─────────────────────
  getAllPlanConfigs(): Record<PlanTier, PlanConfig> {
    return PLAN_CONFIGS;
  }
}
