/**
 * PlatformAnalyticsService — V60 PATCHED
 *
 * Fixes applied:
 *   [H3] Hardcoded LTV ₹3,000 replaced with PLATFORM_ASSUMED_LTV_INR env var
 *        in all 3 locations:
 *          1. syncMetrics()    — ltvCacRatio persisted to platform_metrics
 *          2. getDashboard()   — ltvCacRatio in dashboard response
 *          3. snapshotDailyGrowth() — averageLtv / ltvCacRatio in growth snapshot
 *
 *        Default remains 3000 so existing deploys are unaffected.
 *        Set PLATFORM_ASSUMED_LTV_INR=5000 in .env to change without redeploy.
 *
 *        Note: This is still an assumed LTV — the proper fix is to compute LTV
 *        from real subscription revenue, cohort retention, and churn data.
 *        Until that telemetry is fully wired, the env var prevents stale hardcodes
 *        from making dashboard numbers fabricated and unchangeable.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc, and, gte } from 'drizzle-orm';
import { Pool } from 'pg';
import { DB_TOKEN, DB_POOL } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import {
  platformMetrics,
  platformCampaigns,
  platformLeads,
  platformGrowthAnalytics,
} from './platform-ads.schema';
import { AlertingService } from '../alerting/alerting.service';

export interface PlatformDashboardData {
  activeCampaigns:            number;
  todaySpendInr:              number;
  monthlyRevenueInr:          number;
  averageCac:                 number;
  averageRoas:                number;
  signupConversionRate:       number;
  subscriptionConversionRate: number;
  todaySignups:               number;
  todaySubscriptions:         number;
  ltvCacRatio:                number;
  assumedLtvInr:              number;     // surface the assumption so callers know it's estimated
  topCampaigns:               CampaignSummary[];
}

export interface CampaignSummary {
  id:            string;
  name:          string;
  status:        string;
  spendInr:      number;
  roas:          number;
  cac:           number;
  signups:       number;
  subscriptions: number;
}

export interface MetricsSyncPayload {
  campaignId:    string;
  adSetId?:      string;
  creativeId?:   string;
  date?:         Date;
  impressions:   number;
  reach?:        number;
  clicks:        number;
  spendInr:      number;
  signups?:      number;
  trials?:       number;
  subscriptions?: number;
  revenueInr?:   number;
  rawData?:      Record<string, unknown>;
}

@Injectable()
export class PlatformAnalyticsService {
  private readonly logger = new Logger(PlatformAnalyticsService.name);

  /** [H3] Single source of truth for assumed LTV — read once from env at startup */
  private readonly assumedLtvInr: number;

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly alerting: AlertingService,
    private readonly config: ConfigService,
  ) {
    // [H3 FIX] Read from env, not hardcoded. Default 3000 for backwards compat.
    this.assumedLtvInr = parseInt(
      this.config.get<string>('PLATFORM_ASSUMED_LTV_INR', '3000'),
      10,
    );
    this.logger.log(`Platform analytics initialised: assumedLtv=₹${this.assumedLtvInr}`);
  }

  // ── Ingest metrics from Meta sync ─────────────────────────────────────────

  async syncMetrics(payload: MetricsSyncPayload): Promise<void> {
    const date = payload.date ?? new Date();

    const impressions   = payload.impressions;
    const clicks        = payload.clicks;
    const spendInr      = payload.spendInr;
    const signups       = payload.signups ?? 0;
    const trials        = payload.trials ?? 0;
    const subscriptions = payload.subscriptions ?? 0;
    const revenueInr    = payload.revenueInr ?? 0;

    const cpm  = impressions > 0 ? (spendInr / impressions) * 1000 : 0;
    const cpc  = clicks > 0 ? spendInr / clicks : 0;
    const ctr  = impressions > 0 ? clicks / impressions : 0;
    const cac  = subscriptions > 0 ? spendInr / subscriptions : 0;
    const roas = spendInr > 0 ? revenueInr / spendInr : 0;

    const signupCvr = clicks > 0 ? signups / clicks : 0;
    const subCvr    = signups > 0 ? subscriptions / signups : 0;
    const trialCvr  = trials > 0 ? subscriptions / trials : 0;

    // [H3 FIX] Use instance var, not hardcoded 3000
    const ltvCacRatio = cac > 0 ? this.assumedLtvInr / cac : 0;

    await this.db.insert(platformMetrics).values({
      campaignId:   payload.campaignId,
      adSetId:      payload.adSetId ?? null,
      creativeId:   payload.creativeId ?? null,
      date,
      impressions,
      reach:        payload.reach ?? 0,
      clicks,
      spendInr:     String(spendInr),
      cpm:          String(cpm.toFixed(4)),
      cpc:          String(cpc.toFixed(4)),
      ctr:          String(ctr.toFixed(4)),
      cac:          cac > 0 ? String(cac.toFixed(2)) : null,
      roas:         roas > 0 ? String(roas.toFixed(2)) : null,
      signups,
      trials,
      subscriptions,
      signupConversionRate:       String(signupCvr.toFixed(4)),
      subscriptionConversionRate: String(subCvr.toFixed(4)),
      trialConversionRate:        String(trialCvr.toFixed(4)),
      revenueInr:   String(revenueInr),
      ltv:          String(this.assumedLtvInr),   // [H3 FIX]
      ltvCacRatio:  String(ltvCacRatio.toFixed(2)),
      rawData:      payload.rawData ?? {},
    });

    this.logger.debug(
      `Metrics synced: campaign=${payload.campaignId} spend=₹${spendInr} ` +
      `ROAS=${roas.toFixed(2)} CAC=₹${cac.toFixed(0)} LTV/CAC=${ltvCacRatio.toFixed(2)}`,
    );

    if (cac > 5000) {
      await this.alerting.sendWarn({
        title:   'High Platform CAC Alert',
        message: `Campaign ${payload.campaignId}: CAC ₹${cac.toFixed(0)} is very high. Consider pausing.`,
      });
    }

    if (roas > 0 && roas < 1) {
      await this.alerting.sendWarn({
        title:   'Platform ROAS Below Break-Even',
        message: `Campaign ${payload.campaignId}: ROAS ${roas.toFixed(2)} — losing money on every conversion.`,
      });
    }
  }

  // ── Record a lead event ───────────────────────────────────────────────────

  async recordLead(payload: {
    campaignId?:  string;
    creativeId?:  string;
    stage:        typeof platformLeads.$inferInsert['stage'];
    email?:       string;
    phone?:       string;
    metaLeadId?:  string;
    utmSource?:   string;
    utmMedium?:   string;
    utmCampaign?: string;
    metadata?:    Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(platformLeads).values({
      campaignId:  payload.campaignId ?? null,
      creativeId:  payload.creativeId ?? null,
      stage:       payload.stage,
      email:       payload.email,
      phone:       payload.phone,
      metaLeadId:  payload.metaLeadId,
      utmSource:   payload.utmSource,
      utmMedium:   payload.utmMedium,
      utmCampaign: payload.utmCampaign,
      metadata:    payload.metadata ?? {},
      convertedAt: ['SUBSCRIBED', 'TRIAL'].includes(payload.stage) ? new Date() : undefined,
    });
  }

  // ── Admin dashboard data ──────────────────────────────────────────────────

  async getDashboard(): Promise<PlatformDashboardData> {
    const [
      activeCampaigns,
      todayMetrics,
      monthRevenue,
      topCampaigns,
    ] = await Promise.all([
      this.countActiveCampaigns(),
      this.getTodayMetrics(),
      this.getMonthlyRevenue(),
      this.getTopCampaigns(5),
    ]);

    // [H3 FIX] Use instance var in all 3 places it was hardcoded
    const ltvCacRatio = todayMetrics.avgCac > 0
      ? this.assumedLtvInr / todayMetrics.avgCac
      : 0;

    return {
      activeCampaigns,
      todaySpendInr:              todayMetrics.totalSpend,
      monthlyRevenueInr:          monthRevenue,
      averageCac:                 todayMetrics.avgCac,
      averageRoas:                todayMetrics.avgRoas,
      signupConversionRate:       todayMetrics.signupCvr,
      subscriptionConversionRate: todayMetrics.subCvr,
      todaySignups:               todayMetrics.signups,
      todaySubscriptions:         todayMetrics.subscriptions,
      ltvCacRatio,
      assumedLtvInr:              this.assumedLtvInr,  // surface the assumption
      topCampaigns,
    };
  }

  // ── Daily growth analytics snapshot ──────────────────────────────────────

  async snapshotDailyGrowth(): Promise<void> {
    const metrics      = await this.getTodayMetrics();
    const monthRevenue = await this.getMonthlyRevenue();

    // [H3 FIX] Use instance var — was hardcoded '3000' in both ltvCacRatio and averageLtv
    const ltvCacRatio = metrics.avgCac > 0
      ? this.assumedLtvInr / metrics.avgCac
      : 0;

    await this.db.insert(platformGrowthAnalytics).values({
      date:               new Date(),
      dailySignups:       metrics.signups,
      dailyTrials:        metrics.trials,
      dailySubscriptions: metrics.subscriptions,
      dailyAdSpendInr:    String(metrics.totalSpend),
      dailyRevenueInr:    String(metrics.totalRevenue),
      dailyProfitInr:     String(metrics.totalRevenue - metrics.totalSpend),
      monthlyRevenueInr:  String(monthRevenue),
      averageCac:         String(metrics.avgCac.toFixed(2)),
      averageLtv:         String(this.assumedLtvInr),    // [H3 FIX]
      ltvCacRatio:        String(ltvCacRatio.toFixed(2)), // [H3 FIX]
      blendedRoas:        String(metrics.avgRoas.toFixed(2)),
      blendedCac:         String(metrics.avgCac.toFixed(2)),
    });

    this.logger.log(
      `Daily platform growth snapshot saved: LTV/CAC=${ltvCacRatio.toFixed(2)} ` +
      `(assumed LTV=₹${this.assumedLtvInr})`,
    );
  }

  // ── Campaign-level metrics ────────────────────────────────────────────────

  async getCampaignMetrics(
    campaignId: string,
    days = 7,
  ): Promise<typeof platformMetrics.$inferSelect[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.db
      .select()
      .from(platformMetrics)
      .where(
        and(
          eq(platformMetrics.campaignId, campaignId),
          gte(platformMetrics.date, since),
        ),
      )
      .orderBy(desc(platformMetrics.date));
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async countActiveCampaigns(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM platform_campaigns WHERE status = 'ACTIVE'`,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  private async getTodayMetrics(): Promise<{
    totalSpend: number; totalRevenue: number; avgCac: number; avgRoas: number;
    signupCvr: number; subCvr: number; signups: number; trials: number; subscriptions: number;
  }> {
    const result = await this.pool.query<{
      total_spend: string; total_revenue: string; avg_cac: string; avg_roas: string;
      signup_cvr: string; sub_cvr: string; signups: string; trials: string; subscriptions: string;
    }>(`
      SELECT
        COALESCE(SUM(spend_inr::numeric), 0)::text           AS total_spend,
        COALESCE(SUM(revenue_inr::numeric), 0)::text         AS total_revenue,
        COALESCE(AVG(NULLIF(cac::numeric, 0)), 0)::text      AS avg_cac,
        COALESCE(AVG(NULLIF(roas::numeric, 0)), 0)::text     AS avg_roas,
        COALESCE(AVG(NULLIF(signup_conversion_rate::numeric, 0)), 0)::text AS signup_cvr,
        COALESCE(AVG(NULLIF(subscription_conversion_rate::numeric, 0)), 0)::text AS sub_cvr,
        COALESCE(SUM(signups), 0)::text                      AS signups,
        COALESCE(SUM(trials), 0)::text                       AS trials,
        COALESCE(SUM(subscriptions), 0)::text                AS subscriptions
      FROM platform_metrics
      WHERE date >= CURRENT_DATE
    `);
    const r = result.rows[0];
    return {
      totalSpend:    Number(r?.total_spend ?? 0),
      totalRevenue:  Number(r?.total_revenue ?? 0),
      avgCac:        Number(r?.avg_cac ?? 0),
      avgRoas:       Number(r?.avg_roas ?? 0),
      signupCvr:     Number(r?.signup_cvr ?? 0),
      subCvr:        Number(r?.sub_cvr ?? 0),
      signups:       Number(r?.signups ?? 0),
      trials:        Number(r?.trials ?? 0),
      subscriptions: Number(r?.subscriptions ?? 0),
    };
  }

  private async getMonthlyRevenue(): Promise<number> {
    const result = await this.pool.query<{ total: string }>(`
      SELECT COALESCE(SUM(revenue_inr::numeric), 0)::text AS total
      FROM platform_metrics
      WHERE date >= DATE_TRUNC('month', CURRENT_DATE)
    `);
    return Number(result.rows[0]?.total ?? 0);
  }

  private async getTopCampaigns(limit: number): Promise<CampaignSummary[]> {
    const result = await this.pool.query<{
      id: string; name: string; status: string;
      spend_inr: string; roas: string; cac: string;
      signups: string; subscriptions: string;
    }>(`
      SELECT
        c.id, c.name, c.status,
        COALESCE(SUM(m.spend_inr::numeric), 0)::text        AS spend_inr,
        COALESCE(AVG(NULLIF(m.roas::numeric, 0)), 0)::text  AS roas,
        COALESCE(AVG(NULLIF(m.cac::numeric, 0)), 0)::text   AS cac,
        COALESCE(SUM(m.signups), 0)::text                   AS signups,
        COALESCE(SUM(m.subscriptions), 0)::text             AS subscriptions
      FROM platform_campaigns c
      LEFT JOIN platform_metrics m ON m.campaign_id = c.id
        AND m.date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY c.id, c.name, c.status
      ORDER BY SUM(m.signups) DESC NULLS LAST
      LIMIT $1
    `, [limit]);

    return result.rows.map(r => ({
      id:            r.id,
      name:          r.name,
      status:        r.status,
      spendInr:      Number(r.spend_inr),
      roas:          Number(r.roas),
      cac:           Number(r.cac),
      signups:       Number(r.signups),
      subscriptions: Number(r.subscriptions),
    }));
  }
}
