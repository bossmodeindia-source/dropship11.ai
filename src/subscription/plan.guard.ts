/**
 * PlanGuard — Subscription Feature Gate
 *
 * Applied as a route guard to block access based on subscription plan.
 *
 * Usage:
 *   @UseGuards(PlanGuard)
 *   @RequiresPlan('pro')       // blocks free users
 *   @Post('campaigns/paid')
 *   async launchPaidCampaign() { ... }
 *
 *   @UseGuards(PlanGuard)
 *   @RequiresPlan('elite')     // blocks free and pro users
 *   @Post('advanced-automation')
 *   async runAdvancedAutomation() { ... }
 *
 *   @UseGuards(PlanGuard)
 *   @RequiresFeature('adsEnabled')  // checks specific feature flag
 *   @Post('meta-ads/launch')
 *   async launchMetaAd() { ... }
 *
 * The guard reads subscription state from DB (not Razorpay in real-time)
 * so it stays operational even if Razorpay is unreachable.
 *
 * Bot limit check:
 *   @UseGuards(PlanGuard)
 *   @CheckBotLimit()            // enforces maxBots for current plan
 *   @Post('bots')
 *   async createBot() { ... }
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Inject } from '@nestjs/common';
import { eq, and, count } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import * as wSchema from '../withdrawal/withdrawal-schema';
import { SubscriptionPlan, PLAN_FEATURES } from './dto/subscription.dto';

// ── Metadata keys ─────────────────────────────────────────────────────────────

export const REQUIRES_PLAN_KEY    = 'requiresPlan';
export const REQUIRES_FEATURE_KEY = 'requiresFeature';
export const CHECK_BOT_LIMIT_KEY  = 'checkBotLimit';

/** Require a minimum subscription plan */
export const RequiresPlan = (plan: SubscriptionPlan) =>
  SetMetadata(REQUIRES_PLAN_KEY, plan);

/** Require a specific feature flag to be enabled */
export const RequiresFeature = (feature: 'adsEnabled' | 'advancedAutomation') =>
  SetMetadata(REQUIRES_FEATURE_KEY, feature);

/** Check that user hasn't exceeded their bot limit */
export const CheckBotLimit = () =>
  SetMetadata(CHECK_BOT_LIMIT_KEY, true);

// ── Plan hierarchy ────────────────────────────────────────────────────────────

const PLAN_TIER: Record<SubscriptionPlan, number> = {
  free:  0,
  pro:   1,
  elite: 2,
};

@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req      = context.switchToHttp().getRequest<any>();
    const userId   = req.user?.id   as string | undefined;
    const tenantId = req.tenantId   as string | undefined;

    if (!userId || !tenantId) return true; // auth guards handle this

    // Load subscription once
    const [sub] = await this.db
      .select()
      .from(wSchema.userSubscriptions)
      .where(
        and(
          eq(wSchema.userSubscriptions.userId,   userId),
          eq(wSchema.userSubscriptions.tenantId, tenantId),
        ),
      )
      .limit(1);

    const currentPlan = (sub?.plan ?? 'free') as SubscriptionPlan;
    const currentTier = PLAN_TIER[currentPlan];

    // ── Plan tier check ────────────────────────────────────────────────────
    const requiredPlan = this.reflector.getAllAndOverride<SubscriptionPlan>(
      REQUIRES_PLAN_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredPlan) {
      const requiredTier = PLAN_TIER[requiredPlan];
      if (currentTier < requiredTier) {
        throw new ForbiddenException(
          `This feature requires the ${requiredPlan.toUpperCase()} plan or higher. ` +
          `You are on the ${currentPlan.toUpperCase()} plan.`,
        );
      }
    }

    // ── Feature flag check ─────────────────────────────────────────────────
    const requiredFeature = this.reflector.getAllAndOverride<string>(
      REQUIRES_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredFeature && sub) {
      const hasFeature = sub[requiredFeature as keyof typeof sub] as boolean;
      if (!hasFeature) {
        throw new ForbiddenException(
          `Feature '${requiredFeature}' is not available on your current plan. ` +
          `Upgrade to PRO or ELITE to unlock it.`,
        );
      }
    }

    // ── Bot limit check ────────────────────────────────────────────────────
    const checkBotLimit = this.reflector.getAllAndOverride<boolean>(
      CHECK_BOT_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (checkBotLimit) {
      const maxBots = sub?.maxBots ?? PLAN_FEATURES.free.maxBots;

      const [{ botCount }] = await this.db
        .select({ botCount: count() })
        .from(schema.bots)
        .where(
          and(
            eq(schema.bots.userId,   userId),
            eq(schema.bots.isActive, true),
          ),
        );

      if ((botCount ?? 0) >= maxBots) {
        throw new ForbiddenException(
          `You have reached your bot limit of ${maxBots} (${currentPlan.toUpperCase()} plan). ` +
          `Upgrade to create more bots.`,
        );
      }
    }

    return true;
  }
}
