/**
 * MetaApiClient — V60 PATCHED
 *
 * Fixes applied:
 *   [C1] forceKillAllCampaigns now queries FROM platform_campaigns WHERE status = 'ACTIVE'
 *        instead of FROM campaigns (which is the tenant commerce table).
 *        This eliminates the risk of touching tenant ads and ensures the platform
 *        emergency kill actually reaches the right rows.
 *
 *   All other methods are unchanged from V60 baseline.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { MetaApiExecutionGuard } from '../common/guards/meta-api-execution.guard';
import { POOL_TOKEN } from '../common/database/database.module';

export interface MetaCampaignPayload {
  name: string;
  objective: 'CONVERSIONS' | 'TRAFFIC' | 'AWARENESS' | 'ENGAGEMENT';
  status: 'ACTIVE' | 'PAUSED';
  special_ad_categories: string[];
  daily_budget?: number;
}

export interface MetaAdSetPayload {
  name: string;
  campaign_id: string;
  daily_budget: number;
  billing_event: string;
  optimization_goal: string;
  targeting: Record<string, unknown>;
  status: 'ACTIVE' | 'PAUSED';
}

export interface MetaCreativePayload {
  name: string;
  object_story_spec: {
    page_id: string;
    link_data: {
      message: string;
      name: string;
      call_to_action: { type: string };
      image_url?: string;
      link: string;
    };
  };
}

export interface MetaCustomAudiencePayload {
  name: string;
  description?: string;
  subtype: 'CUSTOM';
  customer_file_source: 'USER_PROVIDED_ONLY';
}

export interface MetaApiResponse {
  id: string;
  [key: string]: unknown;
}

/** INR-to-USD exchange rate for Meta budget conversion.
 *  Override via META_INR_TO_USD_RATE env var (e.g. "0.012").
 *  Default 0.012 = 1 INR ≈ $0.012 USD.
 *  Meta account currency is USD; budget is submitted in USD cents.
 */
export const DEFAULT_INR_TO_USD = 0.012;

@Injectable()
export class MetaApiClient {
  private readonly logger    = new Logger(MetaApiClient.name);
  private readonly baseUrl   = 'https://graph.facebook.com/v18.0';
  private readonly token:     string;
  private readonly accountId: string;
  private readonly pageId:    string;
  private readonly isMock:    boolean;
  readonly inrToUsd:          number;

  constructor(
    private readonly config: ConfigService,
    @Inject(POOL_TOKEN)
    private readonly pool:   Pool,
  ) {
    this.token     = this.config.get<string>('META_ACCESS_TOKEN', 'mock');
    this.accountId = this.config.get<string>('META_AD_ACCOUNT_ID', 'act_000000000');
    this.pageId    = this.config.get<string>('META_PAGE_ID', '000000000');
    this.isMock    = !this.token || this.token === 'mock';
    this.inrToUsd  = parseFloat(
      this.config.get<string>('META_INR_TO_USD_RATE', String(DEFAULT_INR_TO_USD)),
    );
  }

  /** Convert INR budget to Meta USD-cents for daily_budget field. */
  inrToMetaCents(amountInr: number): number {
    return Math.round(amountInr * this.inrToUsd * 100);
  }

  // ── Mutation methods (all GUARDED) ───────────────────────────────────────

  /** POST /act_{adAccountId}/campaigns — GUARDED */
  async createCampaign(payload: MetaCampaignPayload): Promise<MetaApiResponse> {
    MetaApiExecutionGuard.assertInKernelContext('createCampaign');
    if (this.isMock) return this.mockResponse('campaign');
    return this.post(`/${this.accountId}/campaigns`, payload as unknown as Record<string, unknown>);
  }

  /** POST /act_{adAccountId}/adsets — GUARDED */
  async createAdSet(payload: MetaAdSetPayload): Promise<MetaApiResponse> {
    MetaApiExecutionGuard.assertInKernelContext('createAdSet');
    if (this.isMock) return this.mockResponse('adset');
    return this.post(`/${this.accountId}/adsets`, payload as unknown as Record<string, unknown>);
  }

  /** POST /act_{adAccountId}/adcreatives — GUARDED */
  async createAdCreative(payload: MetaCreativePayload): Promise<MetaApiResponse> {
    MetaApiExecutionGuard.assertInKernelContext('createAdCreative');
    if (this.isMock) return this.mockResponse('creative');
    return this.post(`/${this.accountId}/adcreatives`, payload as unknown as Record<string, unknown>);
  }

  /**
   * POST /act_{adAccountId}/customaudiences
   * Creates a Meta Custom Audience for retargeting.
   * GUARDED — caller must be in kernel or emergency context.
   */
  async createCustomAudience(payload: MetaCustomAudiencePayload): Promise<MetaApiResponse> {
    MetaApiExecutionGuard.assertInKernelContext('createCustomAudience');
    if (this.isMock) {
      this.logger.debug(`[MOCK] createCustomAudience name=${payload.name}`);
      return this.mockResponse('custom_audience');
    }
    return this.post(`/${this.accountId}/customaudiences`, payload as unknown as Record<string, unknown>);
  }

  /**
   * POST /{audienceId}/users — Upload hashed email list to a Meta Custom Audience.
   * Emails MUST be pre-hashed (SHA-256) before calling this method.
   * GUARDED.
   */
  async uploadAudienceUsers(
    audienceId: string,
    hashedEmails: string[],
  ): Promise<{ num_received: number; num_invalid_entries: number }> {
    MetaApiExecutionGuard.assertInKernelContext('uploadAudienceUsers');
    if (this.isMock) {
      this.logger.debug(`[MOCK] uploadAudienceUsers audienceId=${audienceId} count=${hashedEmails.length}`);
      return { num_received: hashedEmails.length, num_invalid_entries: 0 };
    }
    const res = await fetch(`${this.baseUrl}/${audienceId}/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        payload: {
          schema: ['EMAIL_SHA256'],
          data:   hashedEmails.map(h => [h]),
        },
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Meta uploadAudienceUsers ${res.status}: ${err.slice(0, 200)}`);
    }
    return res.json() as Promise<{ num_received: number; num_invalid_entries: number }>;
  }

  /** PATCH /{adsetId} — Update daily_budget in USD cents — GUARDED */
  async updateAdsetBudget(adsetId: string, dailyBudgetUsdCents: number): Promise<void> {
    MetaApiExecutionGuard.assertInKernelContext('updateAdsetBudget');
    if (this.isMock) {
      this.logger.debug(`[MOCK] updateAdsetBudget adset=${adsetId} budget_cents=${dailyBudgetUsdCents}`);
      return;
    }
    const res = await fetch(`${this.baseUrl}/${adsetId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${this.token}`,
      },
      body: JSON.stringify({ daily_budget: dailyBudgetUsdCents }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Meta updateAdsetBudget ${res.status}: ${err.slice(0, 200)}`);
    }
  }

  /**
   * PATCH /{campaignId} status=PAUSED — EMERGENCY GUARDED.
   * Caller MUST wrap in MetaApiExecutionGuard.runInEmergencyContext().
   */
  async pauseCampaign(
    metaCampaignId: string,
    idempotencyKey: string,
  ): Promise<{ success: boolean; result: Record<string, unknown> }> {
    MetaApiExecutionGuard.assertInKernelContext('pauseCampaign');
    if (this.isMock) {
      this.logger.debug(`[MOCK] pauseCampaign campaignId=${metaCampaignId} key=${idempotencyKey}`);
      return { success: true, result: { id: metaCampaignId, status: 'PAUSED' } };
    }
    const res = await fetch(`${this.baseUrl}/${metaCampaignId}`, {
      method: 'POST',
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
    return { success: true, result: await res.json() as Record<string, unknown> };
  }

  /** Resume a previously paused campaign — GUARDED */
  async resumeCampaign(
    metaCampaignId: string,
  ): Promise<{ success: boolean; result: Record<string, unknown> }> {
    MetaApiExecutionGuard.assertInKernelContext('resumeCampaign');
    if (this.isMock) {
      this.logger.debug(`[MOCK] resumeCampaign campaignId=${metaCampaignId}`);
      return { success: true, result: { id: metaCampaignId, status: 'ACTIVE' } };
    }
    const res = await fetch(`${this.baseUrl}/${metaCampaignId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${this.token}`,
      },
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Meta resume ${res.status}: ${body.slice(0, 200)}`);
    }
    return { success: true, result: await res.json() as Record<string, unknown> };
  }

  /**
   * [C1] FIXED: Emergency kill targeting platform_campaigns only.
   *
   * BEFORE (bug): queried FROM campaigns — the tenant commerce table.
   *   - Silently did nothing to platform campaigns.
   *   - Risked touching / leaking tenant ad IDs.
   *
   * AFTER (fix): queries FROM platform_campaigns WHERE status = 'ACTIVE'.
   *   - Correctly reads only the platform-owned campaigns.
   *   - No tenant tables are touched.
   *   - Pauses + GET-verifies each campaign individually.
   *   - Returns real killedCount / failedCount.
   *
   * Caller (HardCapitalLimitEngine) wraps in runInEmergencyContext('ALL').
   */
  async forceKillAllCampaigns(_userId?: string): Promise<{ killedCount: number; failedCount: number }> {
    MetaApiExecutionGuard.assertInKernelContext('forceKillAllCampaigns');

    if (this.isMock) {
      this.logger.warn('[MOCK] forceKillAllCampaigns — no real Meta calls in mock mode');
      return { killedCount: 0, failedCount: 0 };
    }

    // ── [C1] FIXED: query platform_campaigns, not campaigns ────────────────
    let activeCampaigns: Array<{ id: string; meta_campaign_id: string }>;
    try {
      const { rows } = await this.pool.query<{ id: string; meta_campaign_id: string }>(`
        SELECT id, meta_campaign_id
        FROM platform_campaigns
        WHERE status = 'ACTIVE'
          AND meta_campaign_id IS NOT NULL
          AND meta_campaign_id <> ''
      `);
      activeCampaigns = rows;
    } catch (err) {
      this.logger.error(`forceKillAllCampaigns: DB fetch failed — ${(err as Error).message}`);
      throw err;
    }

    this.logger.error(
      `[EMERGENCY KILL] Targeting ${activeCampaigns.length} active platform_campaigns for immediate PAUSE`,
    );

    let killedCount = 0;
    let failedCount = 0;

    await Promise.allSettled(
      activeCampaigns.map(async (campaign) => {
        try {
          const pauseRes = await fetch(`${this.baseUrl}/${campaign.meta_campaign_id}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization:  `Bearer ${this.token}`,
            },
            body: JSON.stringify({ status: 'PAUSED' }),
          });

          if (!pauseRes.ok) {
            const body = await pauseRes.text().catch(() => '');
            throw new Error(`PAUSE failed ${pauseRes.status}: ${body.slice(0, 200)}`);
          }

          // GET-verify paused state
          const verifyRes = await fetch(
            `${this.baseUrl}/${campaign.meta_campaign_id}?fields=status&access_token=${this.token}`,
          );
          if (!verifyRes.ok) {
            throw new Error(`Verify GET failed ${verifyRes.status}`);
          }
          const verifyData = await verifyRes.json() as { status: string };
          if (verifyData.status !== 'PAUSED') {
            throw new Error(
              `Verify FAILED: expected PAUSED got ${verifyData.status} ` +
              `for campaign=${campaign.meta_campaign_id}`,
            );
          }

          killedCount++;
          this.logger.warn(
            `[EMERGENCY KILL] ✅ Paused+verified platform_campaigns.id=${campaign.id} ` +
            `meta=${campaign.meta_campaign_id}`,
          );
        } catch (err) {
          failedCount++;
          this.logger.error(
            `[EMERGENCY KILL] ❌ FAILED platform_campaigns.id=${campaign.id} ` +
            `meta=${campaign.meta_campaign_id}: ${(err as Error).message}`,
          );
        }
      }),
    );

    this.logger.error(
      `[EMERGENCY KILL] Complete: killed=${killedCount} failed=${failedCount} ` +
      `total=${activeCampaigns.length}`,
    );

    if (failedCount > 0) {
      this.logger.error(
        `[EMERGENCY KILL] WARNING: ${failedCount} platform campaigns NOT confirmed PAUSED. ` +
        `Manual intervention required.`,
      );
    }

    return { killedCount, failedCount };
  }

  get effectivePageId(): string {
    return this.pageId;
  }

  // ── READ-ONLY (no guard needed) ─────────────────────────────────────────

  async getCampaignStatus(metaCampaignId: string): Promise<{ status: string; dailyBudget: number }> {
    if (this.isMock) return { status: 'PAUSED', dailyBudget: 0 };
    const res = await fetch(
      `${this.baseUrl}/${metaCampaignId}?fields=status,daily_budget&access_token=${this.token}`,
    );
    if (!res.ok) throw new Error(`Meta getCampaignStatus ${res.status}`);
    const data = await res.json() as { status: string; daily_budget: string };
    return { status: data.status, dailyBudget: parseFloat(data.daily_budget ?? '0') / 100 };
  }

  async getAdsetBudget(metaAdsetId: string): Promise<{ dailyBudgetCents: number }> {
    if (this.isMock) return { dailyBudgetCents: 500 * 100 };
    const res = await fetch(
      `${this.baseUrl}/${metaAdsetId}?fields=daily_budget&access_token=${this.token}`,
    );
    if (!res.ok) throw new Error(`Meta getAdsetBudget ${res.status}`);
    const data = await res.json() as { daily_budget: string };
    return { dailyBudgetCents: parseInt(data.daily_budget ?? '0', 10) };
  }

  /** Generic adset update (status, daily_budget, etc.) */
  async updateAdSet(adSetId: string, payload: Record<string, unknown>): Promise<void> {
    if (this.isMock) {
      this.logger.debug(`[MOCK] updateAdSet adSetId=${adSetId} payload=${JSON.stringify(payload)}`);
      return;
    }
    const res = await fetch(`${this.baseUrl}/${adSetId}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${this.token}`,
      },
      body: JSON.stringify({ ...payload, access_token: this.token }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Meta updateAdSet ${res.status}: ${err.slice(0, 200)}`);
    }
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async post(path: string, body: Record<string, unknown>): Promise<MetaApiResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Meta API ${res.status}: ${errText}`);
    }

    return res.json() as Promise<MetaApiResponse>;
  }

  private mockResponse(type: string): MetaApiResponse {
    const id = `mock_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.logger.debug(`[MOCK] Meta ${type} → ${id}`);
    return { id };
  }
}
