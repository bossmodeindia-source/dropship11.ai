/**
 * CommerceAnalyticsService
 *
 * Real-time and historical KPI analytics engine.
 *
 * Tracks per-tenant:
 *   - ROAS  (Return on Ad Spend)
 *   - CAC   (Customer Acquisition Cost)
 *   - LTV   (Lifetime Value — 30d / 90d)
 *   - CTR   (Click-Through Rate)
 *   - CVR   (Conversion Rate)
 *   - AOV   (Average Order Value)
 *   - Gross Revenue / Net Profit
 *   - Churn Rate
 *   - Virality Score
 *
 * Snapshots are taken hourly via cron and stored in commerce_kpi_snapshots.
 * Dashboard reads live from escrow + meta_ad_performance tables.
 *
 * PRIVACY INVARIANT:
 *   Returns are always net of admin_commission.
 *   admin_commission is NEVER surfaced to tenants.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, and, desc, sql, gte } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import {
  commerceKpiSnapshots,
  escrowTransactions,
  growthLoopEvents,
} from '../escrow/escrow-schema';

export interface CommerceKpis {
  tenantId:        string;
  period:          string;
  roas:            number | null;
  cac:             number | null;
  ltv30d:          number | null;
  ltv90d:          number | null;
  ctr:             number | null;
  conversionRate:  number | null;
  aov:             number | null;
  grossRevenue:    number;
  netProfit:       number;
  adSpend:         number;
  ordersCount:     number;
  newCustomers:    number;
  repeatCustomers: number;
  churnRate:       number | null;
  viralityScore:   number | null;
  snapshotAt:      Date;
}

@Injectable()
export class CommerceAnalyticsService {
  private readonly logger = new Logger(CommerceAnalyticsService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  // ── Hourly KPI snapshot ────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async takeHourlySnapshots(): Promise<void> {
    const tenantRows = await this.db.execute<{ user_id: string }>(
      sql`SELECT DISTINCT user_id FROM orders WHERE created_at > NOW() - INTERVAL '7 days'`,
    );

    for (const { user_id } of tenantRows.rows) {
      try {
        const kpis = await this.computeLiveKpis(user_id, 'hourly', 24);
        await this.db.insert(commerceKpiSnapshots).values({
          tenantId:        user_id,
          period:          'hourly',
          roas:            kpis.roas   != null ? String(kpis.roas)   : null,
          cac:             kpis.cac    != null ? String(kpis.cac)    : null,
          ltv30d:          kpis.ltv30d != null ? String(kpis.ltv30d) : null,
          ltv90d:          kpis.ltv90d != null ? String(kpis.ltv90d) : null,
          ctr:             kpis.ctr    != null ? String(kpis.ctr)    : null,
          conversionRate:  kpis.conversionRate != null ? String(kpis.conversionRate) : null,
          aov:             String(kpis.aov ?? 0),
          grossRevenue:    String(kpis.grossRevenue),
          netProfit:       String(kpis.netProfit),
          adSpend:         String(kpis.adSpend),
          ordersCount:     kpis.ordersCount,
          newCustomers:    kpis.newCustomers,
          repeatCustomers: kpis.repeatCustomers,
          churnRate:       kpis.churnRate != null ? String(kpis.churnRate) : null,
          viralityScore:   kpis.viralityScore != null ? String(kpis.viralityScore) : null,
        } as any);
      } catch (err) {
        this.logger.warn(`KPI snapshot failed for tenant ${user_id}: ${err}`);
      }
    }
  }

  // ── Live KPI computation ───────────────────────────────────────────────────

  async computeLiveKpis(
    tenantId:  string,
    period:    'hourly' | 'daily' | 'weekly' | 'monthly',
    lookbackH: number,
  ): Promise<CommerceKpis> {
    const since = new Date(Date.now() - lookbackH * 3_600_000);

    // ── Revenue from escrow (user-safe: user_profit only) ────────────────────
    const revenueRows = await this.db.execute<{
      gross:    number; fee: number; prod_cost: number;
      ship_cost: number; tax: number; commission: number;
      order_cnt: number; new_cust: number;
    }>(sql`
      SELECT
        SUM(customer_paid_amount)                                AS gross,
        SUM(razorpay_fee)                                        AS fee,
        SUM(supplier_product_cost)                               AS prod_cost,
        SUM(supplier_shipping_cost)                              AS ship_cost,
        SUM(tax_amount)                                          AS tax,
        SUM(admin_commission)                                    AS commission,
        COUNT(*)                                                 AS order_cnt,
        COUNT(DISTINCT order_id)                                 AS new_cust
      FROM escrow_transactions
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${since}
        AND status NOT IN ('FAILED','REFUNDED')
    `);

    const rev = revenueRows.rows[0];
    const gross        = +rev?.gross      || 0;
    const fee          = +rev?.fee        || 0;
    const prodCost     = +rev?.prod_cost  || 0;
    const shipCost     = +rev?.ship_cost  || 0;
    const tax          = +rev?.tax        || 0;
    const commission   = +rev?.commission || 0;
    const netProfit    = +(gross - fee - prodCost - shipCost - tax - commission).toFixed(2);
    const ordersCount  = +rev?.order_cnt  || 0;
    const newCustomers = +rev?.new_cust   || 0;

    // ── Ad spend from meta_ad_performance (if table exists) ──────────────────
    let adSpend = 0;
    try {
      const adRows = await this.db.execute<{ spend: number }>(sql`
        SELECT COALESCE(SUM(spend), 0) AS spend
        FROM meta_ad_performance
        WHERE tenant_id = ${tenantId}
          AND date_start >= ${since}
      `);
      adSpend = +adRows.rows[0]?.spend || 0;
    } catch { /* table may not exist in all deployments */ }

    const roas = adSpend > 0 ? +(gross / adSpend).toFixed(4) : null;
    const cac  = newCustomers > 0 && adSpend > 0 ? +(adSpend / newCustomers).toFixed(2) : null;
    const aov  = ordersCount > 0 ? +(gross / ordersCount).toFixed(2) : null;

    // ── LTV from lifecycle segments ───────────────────────────────────────────
    let ltv30d: number | null = null;
    let ltv90d: number | null = null;
    try {
      const ltvRows = await this.db.execute<{ ltv30: number; ltv90: number }>(sql`
        SELECT
          AVG(ltv_score)          AS ltv30,
          AVG(predicted_ltv_90d)  AS ltv90
        FROM lifecycle_customer_segments
        WHERE tenant_id = ${tenantId}
      `);
      ltv30d = +ltvRows.rows[0]?.ltv30 || null;
      ltv90d = +ltvRows.rows[0]?.ltv90 || null;
    } catch { /* lifecycle table may not yet have data */ }

    // ── Repeat customer count ──────────────────────────────────────────────────
    let repeatCustomers = 0;
    try {
      const repRows = await this.db.execute<{ cnt: number }>(sql`
        SELECT COUNT(*) AS cnt
        FROM lifecycle_customer_segments
        WHERE tenant_id = ${tenantId}
          AND total_orders > 1
      `);
      repeatCustomers = +repRows.rows[0]?.cnt || 0;
    } catch {}

    return {
      tenantId,
      period,
      roas,
      cac,
      ltv30d,
      ltv90d,
      ctr:             null,  // populated from Meta webhook data
      conversionRate:  null,  // populated from Meta conversion data
      aov,
      grossRevenue:    gross,
      netProfit,
      adSpend,
      ordersCount,
      newCustomers,
      repeatCustomers,
      churnRate:       null,
      viralityScore:   null,
      snapshotAt:      new Date(),
    };
  }

  // ── Get snapshot history ──────────────────────────────────────────────────

  async getSnapshotHistory(
    tenantId: string,
    period:   'hourly' | 'daily' | 'weekly',
    limit  = 30,
  ): Promise<CommerceKpis[]> {
    const rows = await this.db
      .select()
      .from(commerceKpiSnapshots)
      .where(and(
        eq(commerceKpiSnapshots.tenantId, tenantId),
        eq(commerceKpiSnapshots.period, period),
      ))
      .orderBy(desc(commerceKpiSnapshots.snapshotAt))
      .limit(limit);

    return rows as unknown as CommerceKpis[];
  }

  // ── Real-time dashboard summary ───────────────────────────────────────────

  async getDashboardSummary(tenantId: string): Promise<{
    today:   CommerceKpis;
    last7d:  CommerceKpis;
    last30d: CommerceKpis;
  }> {
    const [today, last7d, last30d] = await Promise.all([
      this.computeLiveKpis(tenantId, 'daily',   24),
      this.computeLiveKpis(tenantId, 'weekly',  168),
      this.computeLiveKpis(tenantId, 'monthly', 720),
    ]);
    return { today, last7d, last30d };
  }
}
