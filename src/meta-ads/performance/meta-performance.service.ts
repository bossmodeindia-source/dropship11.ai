/**
 * MetaPerformanceService — FIX 1 APPLIED
 *
 * ALL mutation methods (pauseCampaign, updateCampaignBudget, updateAdsetBudget)
 * now assert kernel context before touching Meta API.
 * Called outside RCCSKernel → HARD THROW. No bypass possible.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, or } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { DB_TOKEN } from '../../common/database/database.module';
import * as schema from '../../common/database/schema';
import { MetaApiExecutionGuard } from '../../common/guards/meta-api-execution.guard';

export interface CampaignMetrics {
  campaignId:  string;
  impressions: number;
  clicks:      number;
  ctr:         number;
  cpc:         number;
  conversions: number;
  roas:        number;
  spend:       number;
}

export type PerformanceStatus =
  | 'poor' | 'average' | 'good'
  | 'profitable' | 'break_even' | 'loss'
  | 'unknown';

export type CtrStatus           = 'poor' | 'average' | 'good';
export type ProfitabilityStatus = 'profitable' | 'break_even' | 'loss';

export interface PerformanceDecision {
  metrics:           CampaignMetrics;
  ctrStatus:         CtrStatus;
  profitability:     ProfitabilityStatus;
  performanceStatus: PerformanceStatus;
  action:            'scale_budget' | 'pause' | 'monitor';
  budgetMultiplier:  number;
}

interface MetaInsightEdge {
  impressions?: string;
  clicks?:      string;
  spend?:       string;
  actions?:     Array<{ action_type: string; value: string }>;
}

interface MetaInsightsResponse {
  data: MetaInsightEdge[];
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

@Injectable()
export class MetaPerformanceService {
  private readonly logger      = new Logger(MetaPerformanceService.name);
  private readonly baseUrl     = 'https://graph.facebook.com/v20.0';
  private readonly token:       string;
  private readonly isMock:      boolean;
  private readonly roasScaleThreshold: number;
  private readonly assumedAov: number;

  private readonly metricsCache = new Map<string, CampaignMetrics>();

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly config: ConfigService,
  ) {
    this.token  = this.config.get<string>('META_ACCESS_TOKEN', 'mock');
    this.isMock = !this.token || this.token === 'mock';
    this.roasScaleThreshold = Number(this.config.get<number>('ROAS_SCALE_THRESHOLD', 2));
    this.assumedAov = Number(this.config.get<number>('META_ASSUMED_AOV', 50));

    if (this.isMock) {
      this.logger.warn('MetaPerformanceService: META_ACCESS_TOKEN not set — using mock.');
    }
  }

  async fetchMetrics(campaignId: string): Promise<CampaignMetrics> {
    if (this.isMock) {
      const metrics = this.deterministicMock(campaignId);
      this.metricsCache.set(campaignId, metrics);
      return metrics;
    }

    try {
      const metrics = await withRetry(async () => {
        const url = new URL(`${this.baseUrl}/${campaignId}/insights`);
        url.searchParams.set('access_token', this.token);
        url.searchParams.set('fields', 'impressions,clicks,spend,actions');
        url.searchParams.set('date_preset', 'last_7d');
        url.searchParams.set('level', 'campaign');

        const res = await fetch(url.toString(), {
          method:  'GET',
          headers: { Accept: 'application/json' },
          signal:  AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Meta Insights API ${res.status}: ${body.slice(0, 200)}`);
        }

        return res.json() as Promise<MetaInsightsResponse>;
      }, 3, 1000);

      const row = metrics.data?.[0];
      if (!row) return this.getCachedOrEmpty(campaignId);

      const impressions = parseInt(row.impressions ?? '0', 10);
      const clicks      = parseInt(row.clicks ?? '0', 10);
      const spend       = parseFloat(row.spend ?? '0');

      const purchaseAction = row.actions?.find(
        (a) => a.action_type === 'purchase' ||
               a.action_type === 'offsite_conversion.fb_pixel_purchase',
      );
      const conversions = purchaseAction ? parseInt(purchaseAction.value, 10) : 0;

      const ctr = impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0;
      const cpc = clicks > 0      ? +(spend / clicks).toFixed(4) : 0;

      const roas = spend > 0 ? +((conversions * this.assumedAov) / spend).toFixed(4) : 0;
      const result: CampaignMetrics = {
        campaignId, impressions, clicks, ctr, cpc, conversions,
        roas, spend,
      };

      this.metricsCache.set(campaignId, result);
      await this.persistFetchedMetrics(campaignId, result);
      return result;

    } catch (err) {
      this.logger.warn(`MetaPerformanceService: API failed campaign=${campaignId} after 3 retries — using cache.`);
      return this.getCachedOrEmpty(campaignId);
    }
  }

  /**
   * FIX 1: assertInKernelContext() REQUIRED before any Meta mutation.
   * Throws hard if called outside RCCSKernel execution context.
   */
  async pauseCampaign(campaignExternalId: string): Promise<void> {
    // ── FIX 1: HARD GUARD ─────────────────────────────────────────────────
    MetaApiExecutionGuard.assertInKernelContext('MetaPerformanceService.pauseCampaign');

    if (this.isMock || campaignExternalId.startsWith('mock')) {
      this.logger.debug(`[MOCK] Pause campaign=${campaignExternalId}`);
      return;
    }
    await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/${campaignExternalId}`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${this.token}`,
        },
        body: JSON.stringify({ status: 'PAUSED' }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Meta pause ${res.status}: ${body.slice(0, 200)}`);
      }
    }, 3, 1000);
    this.logger.log(`[MetaAPI] ✅ Paused campaign=${campaignExternalId}`);
  }

  /**
   * FIX 1: assertInKernelContext() REQUIRED before any Meta mutation.
   */
  async updateCampaignBudget(campaignExternalId: string, dailyBudgetInr: number): Promise<void> {
    // ── FIX 1: HARD GUARD ─────────────────────────────────────────────────
    MetaApiExecutionGuard.assertInKernelContext('MetaPerformanceService.updateCampaignBudget');

    if (this.isMock || campaignExternalId.startsWith('mock')) {
      this.logger.debug(`[MOCK] Budget update campaign=${campaignExternalId} ₹${dailyBudgetInr}/day`);
      return;
    }
    const budgetInPaise = Math.round(dailyBudgetInr * 100);
    await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/${campaignExternalId}`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${this.token}`,
        },
        body: JSON.stringify({ daily_budget: budgetInPaise }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Meta updateBudget ${res.status}: ${body.slice(0, 200)}`);
      }
    }, 3, 1000);
    this.logger.log(`[MetaAPI] ✅ Budget updated campaign=${campaignExternalId} ₹${dailyBudgetInr}/day`);
  }

  /**
   * FIX 1: assertInKernelContext() REQUIRED before any Meta mutation.
   */
  async updateAdsetBudget(adsetExternalId: string, dailyBudgetInr: number): Promise<void> {
    // ── FIX 1: HARD GUARD ─────────────────────────────────────────────────
    MetaApiExecutionGuard.assertInKernelContext('MetaPerformanceService.updateAdsetBudget');

    if (this.isMock || adsetExternalId.startsWith('mock')) {
      this.logger.debug(`[MOCK] Adset budget adset=${adsetExternalId} ₹${dailyBudgetInr}/day`);
      return;
    }
    const budgetInPaise = Math.round(dailyBudgetInr * 100);
    await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/${adsetExternalId}`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${this.token}`,
        },
        body: JSON.stringify({ daily_budget: budgetInPaise }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Meta adsetBudget ${res.status}: ${body.slice(0, 200)}`);
      }
    }, 3, 1000);
    this.logger.log(`[MetaAPI] ✅ Adset budget updated adset=${adsetExternalId} ₹${dailyBudgetInr}/day`);
  }

  evaluatePerformance(metrics: CampaignMetrics): PerformanceDecision {
    let ctrStatus: CtrStatus;
    if      (metrics.ctr < 1)  ctrStatus = 'poor';
    else if (metrics.ctr <= 2) ctrStatus = 'average';
    else                       ctrStatus = 'good';

    const profitability: ProfitabilityStatus = metrics.roas > this.roasScaleThreshold
      ? 'profitable'
      : metrics.roas < 1
        ? 'loss'
        : 'break_even';
    const performanceStatus: PerformanceStatus = profitability === 'break_even'
      ? ctrStatus
      : profitability;

    const action = profitability === 'profitable'
      ? 'scale_budget'
      : profitability === 'loss'
        ? 'pause'
        : 'monitor';
    const budgetMultiplier = action === 'scale_budget' ? 1.3 : action === 'pause' ? 0 : 1;

    return {
      metrics, ctrStatus, profitability, performanceStatus,
      action, budgetMultiplier,
    };
  }

  async processCampaign(campaignId: string): Promise<void> {
    try {
      const metrics  = await this.fetchMetrics(campaignId);
      const decision = this.evaluatePerformance(metrics);
      await this.persistPerformanceStatus(campaignId, decision.performanceStatus);
    } catch (err) {
      this.logger.error(`processCampaign error id=${campaignId}: ${(err as Error).message}`);
    }
  }

  /**
   * Apply a scaling decision produced by evaluatePerformance().
   * Persists the resulting status change (pause / budget scale) to DB.
   */
  async applyScaling(decision: PerformanceDecision): Promise<void> {
    try {
      if (decision.action === 'pause') {
        await this.db
          .update(schema.campaigns)
          .set({ status: 'paused', updatedAt: new Date() } as any)
          .where(eq(schema.campaigns.performanceStatus, decision.performanceStatus));
        return;
      }

      if (decision.action === 'scale_budget') {
        const rows = await this.db
          .select({ budgetDaily: schema.campaigns.budgetDaily } as any)
          .from(schema.campaigns)
          .where(eq(schema.campaigns.performanceStatus, decision.performanceStatus));

        if (rows.length > 0) {
          const current     = parseFloat((rows[0] as any).budgetDaily ?? '0');
          const newBudget   = (current * (decision.budgetMultiplier ?? 1.3)).toFixed(2);
          await this.db
            .update(schema.campaigns)
            .set({ budgetDaily: newBudget, updatedAt: new Date() } as any)
            .where(eq(schema.campaigns.performanceStatus, decision.performanceStatus));
        }
        return;
      }
    } catch (err) {
      this.logger.error(`applyScaling failed: ${(err as Error).message}`);
    }
  }

  async runFullCycle(): Promise<{ processed: number; errors: number }> {
    let processed = 0;
    let errors    = 0;

    try {
      const activeCampaigns = await this.db
        .select({ id: schema.campaigns.id })
        .from(schema.campaigns)
        .where(and(
          eq(schema.campaigns.platform, 'meta'),
          or(eq(schema.campaigns.status, 'active'), eq(schema.campaigns.status, 'pending')),
        ));

      for (const row of activeCampaigns) {
        try { await this.processCampaign(row.id); processed++; }
        catch { errors++; }
      }
    } catch (err) {
      this.logger.error(`runFullCycle failed: ${(err as Error).message}`);
    }

    return { processed, errors };
  }

  async persistPerformanceStatus(campaignId: string, status: PerformanceStatus): Promise<void> {
    try {
      await this.db
        .update(schema.campaigns)
        .set({ performanceStatus: status, updatedAt: new Date() })
        .where(eq(schema.campaigns.id, campaignId));
    } catch (err) {
      this.logger.error(`persistPerformanceStatus failed campaign=${campaignId}: ${(err as Error).message}`);
    }
  }

  private async persistFetchedMetrics(campaignId: string, metrics: CampaignMetrics): Promise<void> {
    try {
      await this.db
        .update(schema.campaigns)
        .set({
          impressions: metrics.impressions,
          clicks:      metrics.clicks,
          conversions: metrics.conversions,
          ctr:         String(metrics.ctr),
          cpc:         String(metrics.cpc),
          updatedAt:   new Date(),
        })
        .where(eq(schema.campaigns.id, campaignId));
    } catch (err) {
      this.logger.error(`persistFetchedMetrics campaign=${campaignId}: ${(err as Error).message}`);
    }
  }

  private getCachedOrEmpty(campaignId: string): CampaignMetrics {
    return this.metricsCache.get(campaignId) ?? {
      campaignId, impressions: 0, clicks: 0, ctr: 1.0, cpc: 0,
      conversions: 0, roas: 1, spend: 0,
    };
  }

  private deterministicMock(campaignId: string): CampaignMetrics {
    const seed = campaignId.split('').reduce((acc, c) => (acc + c.charCodeAt(0)) % 997, 0);
    const rng = (min: number, max: number, offset: number): number => {
      const s = (seed + offset * 31) % 100;
      return +(min + (s / 100) * (max - min)).toFixed(4);
    };
    const impressions = Math.max(1, Math.floor(rng(500, 50_000, 1)));
    const clicks      = Math.max(0, Math.floor(impressions * rng(0.005, 0.04, 2)));
    const conversions = Math.max(0, Math.floor(clicks * rng(0.01, 0.15, 3)));
    const spend       = +rng(500, 5000, 4).toFixed(2);
    const ctr = impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : 0;
    const cpc = clicks > 0      ? +(spend / clicks).toFixed(4) : 0;
    const roas = spend > 0 ? +((conversions * this.assumedAov) / spend).toFixed(4) : 0;
    return { campaignId, impressions, clicks, ctr, cpc, conversions, roas, spend };
  }
}
