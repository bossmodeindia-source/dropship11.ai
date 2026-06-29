/**
 * GoogleAdsChannelAdapter — V52 Channel Abstraction
 *
 * Implements IAdChannel for Google Ads.
 * - NO direct Google Ads API keys required (simulated / DB-backed).
 * - Structure ready for real Google Ads API integration (OAuth2 + GAQL).
 * - ALL mutations enter via RCCSKernel — this adapter is called from
 *   ChannelRouterService after kernel gates have passed.
 *
 * DOES NOT duplicate V40 GoogleAdsAdapter (which handles signal ingestion).
 * This adapter handles campaign execution routing only.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject }              from '@nestjs/common';
import { Pool }                from 'pg';
import {
  IAdChannel,
  ChannelType,
  ChannelCampaignPayload,
  ChannelExecutionResult,
} from '../channel.interface';

@Injectable()
export class GoogleAdsChannelAdapter implements IAdChannel {
  private readonly log = new Logger(GoogleAdsChannelAdapter.name);

  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  getPlatformName(): ChannelType { return 'google'; }

  async executeCampaign(
    action:  'CREATE' | 'SCALE' | 'PAUSE' | 'KILL',
    payload: ChannelCampaignPayload,
  ): Promise<ChannelExecutionResult> {
    this.log.log(`[GoogleAds] action=${action} campaign=${payload.campaignId} budget=${payload.budget}`);

    try {
      // ── Persist execution intent (audit trail) ──────────────────────────
      await this.pool.query(`
        INSERT INTO channel_execution_log
          (channel, campaign_id, action, budget, metadata, created_at)
        VALUES ('google', $1, $2, $3, $4, NOW())
        ON CONFLICT DO NOTHING
      `, [payload.campaignId, action, payload.budget, JSON.stringify(payload.metadata ?? {})]);

      // ── Simulated ROAS — replace with real Google Ads Reporting API ─────
      // Production: use google-ads-api npm package with OAuth2 credentials
      const simulatedRoas = this.simulateRoas(action, payload.budget);

      return {
      channel: 'google' as 'google',
        success:       true,
        platformId:    `gads_${payload.campaignId}_${Date.now()}`,
        simulatedRoas,
        message:       `Google Ads ${action} simulated OK`,
      };
    } catch (err) {
      this.log.error(`[GoogleAds] execution failed: ${(err as Error).message}`);
      return { success: false, channel: 'google', message: (err as Error).message };
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private simulateRoas(action: string, budget: number): number {
    // Placeholder until real API integration
    // Real impl: query Google Ads API for campaign ROAS estimates
    const base = action === 'SCALE' ? 3.2 : action === 'CREATE' ? 2.8 : 1.0;
    return parseFloat((base + (Math.random() * 0.4 - 0.2)).toFixed(2));
  }
}
