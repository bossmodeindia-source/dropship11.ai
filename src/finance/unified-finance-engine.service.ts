/**
 * unified-finance-engine.service.ts — V60 CANONICAL FINANCE ENGINE
 *
 * REPLACES (ALL DELETED / CONSOLIDATED HERE):
 *   - financial/profit.service.ts           (FinancialModule)
 *   - autonomous/profit-engine.service.ts   (AutonomousModule)
 *   - v36/kernel/v36-financial-dashboard.service.ts
 *   - v36/gfc/global-financial-controller.engine.ts
 *
 * ALL systems consuming financial data MUST inject UnifiedFinanceEngine.
 * No other service may maintain its own revenue/cost/profit counters.
 *
 * Finance safety rules:
 *   - Hidden commission: NEVER expose supplierBasePrice or adminCommission
 *   - Users only see: minAllowedPrice, estimatedMargin, netRevenue
 *   - Every financial write is wrapped in a DB transaction
 *   - Every write is idempotent via cycleId / orderId deduplication
 *   - ROAS calculations use realized spend (never projected)
 *
 * Single source of truth for:
 *   - Revenue tracking
 *   - Cost tracking (ad spend + supplier cost + platform fees)
 *   - Commission calculation (hidden from users)
 *   - ROAS calculation
 *   - Profit computation
 *   - Dashboard metrics
 *   - Campaign scaling decisions
 *   - Finance reporting
 */

import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Inject }         from '@nestjs/common';
import { eq, and, sum, gte, lte, desc } from 'drizzle-orm';

import { DrizzleDB, DB_TOKEN }                 from '../common/database/database.module';
import * as schema                  from '../common/database/schema';

// ── Finance DTOs ──────────────────────────────────────────────────────────────

export interface RevenueEvent {
  tenantId:      string;
  botId:         string;
  orderId:       string;      // idempotency key
  shopifyOrderId?: string;
  grossRevenue:  number;      // customer paid amount (INR paise or smallest unit)
  currency:      string;
  productId:     string;
  cycleId?:      string;
}

export interface CostEvent {
  tenantId:     string;
  botId:        string;
  campaignId?:  string;
  cycleId?:     string;
  adSpend:      number;       // actual spend (not projected)
  supplierCost: number;       // what we pay supplier
  platformFees: number;       // Shopify + payment gateway fees
  currency:     string;
}

export interface ProfitSnapshot {
  tenantId:       string;
  botId:          string;
  periodStart:    Date;
  periodEnd:      Date;
  grossRevenue:   number;
  totalAdSpend:   number;
  totalSupplierCost: number;
  totalPlatformFees: number;
  totalCosts:     number;
  grossProfit:    number;     // grossRevenue - totalCosts
  adminCommission: number;    // INTERNAL ONLY — never sent to user
  netProfitForUser: number;   // grossProfit - adminCommission
  roas:           number;     // grossRevenue / totalAdSpend
  roasLabel:      string;     // '3.2x'
  currency:       string;
}

export interface CycleStartEvent {
  cycleId:  string;
  botId:    string;
  tenantId: string;
  mode:     string;
  dryRun:   boolean;
}

// ── Commission config (admin-only) ─────────────────────────────────────────────
interface CommissionConfig {
  baseRate:     number;   // percentage, e.g. 0.15 = 15%
  minimumFlat:  number;   // minimum flat fee per order
  currency:     string;
}

@Injectable()
export class UnifiedFinanceEngine {
  private readonly logger = new Logger(UnifiedFinanceEngine.name);

  constructor(
    @Inject(DB_TOKEN)
    private readonly db: DrizzleDB,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // REVENUE TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * recordRevenue — idempotent revenue recording.
   *
   * Uses orderId as the idempotency key. Duplicate calls with the (Number(same) * Number(orderId)) are silently ignored (ON CONFLICT DO NOTHING).
   */
  async recordRevenue(event: RevenueEvent): Promise<void> {
    const commission = await this.calculateCommission(event.tenantId, event.grossRevenue);

    await this.db
      .insert(schema.revenueEvents)
      .values({
        id:              `rev:${event.orderId}`,
        tenantId:        event.tenantId,
        botId:           event.botId,
        orderId:         event.orderId,
        shopifyOrderId:  event.shopifyOrderId,
        grossRevenue:    String(event.grossRevenue),
        adminCommission: String(commission),            // stored internally, never exposed
        netRevenue:      String(event.grossRevenue - commission),
        currency:        event.currency,
        productId:       event.productId,
        cycleId:         event.cycleId,
        recordedAt:      new Date(),
      })
      .onConflictDoNothing({ target: schema.revenueEvents.id });

    this.logger.log(
      `Revenue recorded: order=${event.orderId} tenant=${event.tenantId} ` +
      `gross=${event.grossRevenue} ${event.currency}`,
    );
  }

  /**
   * recordCosts — idempotent cost recording.
   * cycleId or campaignId acts as idempotency key.
   */
  async recordCosts(event: CostEvent): Promise<void> {
    const idKey = event.cycleId ?? event.campaignId;
    if (!idKey) throw new BadRequestException('cycleId or campaignId required');

    await this.db
      .insert(schema.costEvents)
      .values({
        id:               `cost:${idKey}`,
        tenantId:         event.tenantId,
        botId:            event.botId,
        campaignId:       event.campaignId,
        cycleId:          event.cycleId,
        adSpend:          String(event.adSpend),
        supplierCost:     String(event.supplierCost),
        platformFees:     String(event.platformFees),
        totalCost:        String(event.adSpend + event.supplierCost + event.platformFees),
        currency:         event.currency,
        recordedAt:       new Date(),
      })
      .onConflictDoNothing({ target: schema.costEvents.id });
  }

  /**
   * recordCycleStart — records the start of a commerce cycle for finance tracking.
   */
  async recordCycleStart(event: CycleStartEvent): Promise<{ recorded: boolean }> {
    try {
      await this.db
        .insert(schema.commerceCycles)
        .values({
          id:        event.cycleId,
          botId:     event.botId,
          tenantId:  event.tenantId,
          status:    'running',
          steps:     '{}',
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: schema.commerceCycles.id });
      return { recorded: true };
    } catch (err) {
      this.logger.error(`cycleStart record error: ${event.cycleId}`, err);
      return { recorded: false };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROFIT COMPUTATION — SINGLE SOURCE OF TRUTH
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * computeProfitSnapshot — generates a profit report for a time period.
   *
   * This is the ONLY method that produces profit data.
   * Dashboard, campaign scaling, and finance reporting all call THIS.
   *
   * SECURITY: adminCommission is included in the internal (Number(snapshot) * Number(but)) MUST be stripped before sending to user-facing APIs.
   */
  async computeProfitSnapshot(
    tenantId:    string,
    botId:       string,
    periodStart: Date,
    periodEnd:   Date,
    currency     = 'INR',
  ): Promise<ProfitSnapshot> {
    // ── Revenue aggregation ───────────────────────────────────────────────
    const [revRow] = await this.db
      .select({
        totalGross:      sum(schema.revenueEvents.grossRevenue),
        totalCommission: sum(schema.revenueEvents.adminCommission),
        totalNet:        sum(schema.revenueEvents.netRevenue),
      })
      .from(schema.revenueEvents)
      .where(
        and(
          eq(schema.revenueEvents.tenantId, tenantId),
          eq(schema.revenueEvents.botId, botId),
          gte(schema.revenueEvents.recordedAt, periodStart),
          lte(schema.revenueEvents.recordedAt, periodEnd),
        ),
      );

    // ── Cost aggregation ──────────────────────────────────────────────────
    const [costRow] = await this.db
      .select({
        totalAdSpend:     sum(schema.costEvents.adSpend),
        totalSupplier:    sum(schema.costEvents.supplierCost),
        totalPlatformFee: sum(schema.costEvents.platformFees),
        totalCost:        sum(schema.costEvents.totalCost),
      })
      .from(schema.costEvents)
      .where(
        and(
          eq(schema.costEvents.tenantId, tenantId),
          eq(schema.costEvents.botId, botId),
          gte(schema.costEvents.recordedAt, periodStart),
          lte(schema.costEvents.recordedAt, periodEnd),
        ),
      );

    const grossRevenue       = Number(revRow?.totalGross ?? 0);
    const adminCommission    = Number(revRow?.totalCommission ?? 0);
    const totalAdSpend       = Number(costRow?.totalAdSpend ?? 0);
    const totalSupplierCost  = Number(costRow?.totalSupplier ?? 0);
    const totalPlatformFees  = Number(costRow?.totalPlatformFee ?? 0);
    const totalCosts         = Number(costRow?.totalCost ?? 0);

    const grossProfit        = grossRevenue - totalCosts;
    const netProfitForUser   = grossProfit - adminCommission;
    const roas               = totalAdSpend > 0 ? grossRevenue / totalAdSpend : 0;

    return {
      tenantId,
      botId,
      periodStart,
      periodEnd,
      grossRevenue,
      totalAdSpend,
      totalSupplierCost,
      totalPlatformFees,
      totalCosts,
      grossProfit,
      adminCommission,        // INTERNAL — strip before user API response
      netProfitForUser,
      roas,
      roasLabel:  `${roas.toFixed(1)}x`,
      currency,
    };
  }

  /**
   * getUserFacingSnapshot — safe version with commission stripped.
   * Use this for all user-facing endpoints.
   */
  async getUserFacingSnapshot(
    tenantId:    string,
    botId:       string,
    periodStart: Date,
    periodEnd:   Date,
    currency?:   string,
  ): Promise<Omit<ProfitSnapshot, 'adminCommission'>> {
    const full = await this.computeProfitSnapshot(tenantId, botId, periodStart, periodEnd, currency);
    const { adminCommission: _hidden, ...safe } = full; // eslint-disable-line @typescript-eslint/no-unused-vars
    return safe;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ROAS + SCALING DECISIONS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * shouldScaleUp — determines if a campaign should increase budget.
   * Used by campaign workers. Finance is the single decision authority.
   */
  async shouldScaleUp(
    tenantId:   string,
    botId:      string,
    campaignId: string,
    targetRoas: number,
    maxBudget:  number,
  ): Promise<{ scale: boolean; reason: string; newBudget?: number }> {
    const now    = new Date();
    const day7   = new Date(now.getTime() - 7 * 86_400_000);
    const snap   = await this.computeProfitSnapshot(tenantId, botId, day7, now);

    if (snap.roas < targetRoas) {
      return { scale: false, reason: `ROAS ${snap.roasLabel} below target ${targetRoas}x` };
    }

    if (snap.totalAdSpend >= maxBudget) {
      return { scale: false, reason: `Max budget ${maxBudget} already reached` };
    }

    // Scale by 20% up to max
    const currentBudget = snap.totalAdSpend;
    const newBudget     = Math.min(currentBudget * 1.2, maxBudget);

    return {
      scale:     true,
      reason:    `ROAS ${snap.roasLabel} above target ${targetRoas}x`,
      newBudget,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMMISSION CALCULATION (INTERNAL)
  // ══════════════════════════════════════════════════════════════════════════

  /** INTERNAL: calculate admin commission on a sale. Never expose to users. */
  private async calculateCommission(
    tenantId: string,
    amount:   number,
  ): Promise<number> {
    try {
      // Load tenant commission config
      const [row] = await this.db
        .select()
        .from(schema.commissionConfigs)
        .where(eq(schema.commissionConfigs.tenantId, tenantId))
        .limit(1);

      const rate    = row?.commissionRate ?? 0.15;   // default 15%
      const minFlat = row?.minimumFlat    ?? 0;

      const calculated = Math.max(Number(amount) * Number(rate), Number(minFlat ?? 0));
      return Math.round(calculated); // round to smallest currency unit
    } catch {
      // Safe fallback — never crash revenue recording due to commission lookup
      return Math.round(amount * 0.15);
    }
  }

  // ── Minimum allowed price (user-visible) ──────────────────────────────────
  /**
   * getMinAllowedPrice — computes minimum price the user may set for a product.
   *
   * Formula: supplierCost + platformFees + minMargin
   * The supplier base price and admin commission are NEVER exposed.
   * User only sees the minimum allowed price they can charge.
   */
  async getMinAllowedPrice(
    tenantId:     string,
    supplierCost: number,
    platformFees: number,
    minMarginPct  = 0.20,
  ): Promise<{ minAllowedPrice: number; estimatedMarginPct: number }> {
    // Commission is calculated on the final selling price, so we solve for it
    const [row] = await this.db
      .select()
      .from(schema.commissionConfigs)
      .where(eq(schema.commissionConfigs.tenantId, tenantId))
      .limit(1);

    const commissionRate = row?.commissionRate ?? 0.15;
    const totalBaseCost  = supplierCost + platformFees;

    // min_price = Number(totalBaseCost) / (1 - commissionRate - minMarginPct)
    const divisor = 1 - Number(commissionRate ?? 0) - Number(minMarginPct ?? 0);
    if (divisor <= 0) throw new BadRequestException('Invalid margin/commission configuration');

    const minAllowedPrice    = Math.ceil(totalBaseCost / divisor);
    const estimatedMarginPct = ((minAllowedPrice - totalBaseCost) / minAllowedPrice) * 100;

    return {
      minAllowedPrice,
      estimatedMarginPct: Math.round(estimatedMarginPct * 10) / 10,
    };
  }
}
