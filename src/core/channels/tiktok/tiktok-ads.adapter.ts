/**
 * TikTokAdsChannelAdapter — V52 Channel Abstraction
 *
 * Implements IAdChannel for TikTok Ads.
 * - NO direct TikTok API keys required (simulated / DB-backed).
 * - Structure ready for real TikTok Business API (OAuth2 + TikTok Ads API v1.3).
 * - ALL mutations enter via RCCSKernel — this adapter is called from
 *   ChannelRouterService after kernel gates have passed.
 *
 * DOES NOT duplicate V40 TikTokAdsAdapter (which handles signal ingestion).
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
export class TikTokAdsChannelAdapter implements IAdChannel {
  private readonly log = new Logger(TikTokAdsChannelAdapter.name);

  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  getPlatformName(): ChannelType { return 'tiktok'; }

  async executeCampaign(
    action:  'CREATE' | 'SCALE' | 'PAUSE' | 'KILL',
    payload: ChannelCampaignPayload,
  ): Promise<ChannelExecutionResult> {
    this.log.log(`[TikTok] action=${action} campaign=${payload.campaignId} budget=${payload.budget}`);

    try {
      await this.pool.query(`
        INSERT INTO channel_execution_log
          (channel, campaign_id, action, budget, metadata, created_at)
        VALUES ('tiktok', $1, $2, $3, $4, NOW())
        ON CONFLICT DO NOTHING
      `, [payload.campaignId, action, payload.budget, JSON.stringify(payload.metadata ?? {})]);

      const simulatedRoas = this.simulateRoas(action, payload.budget);

      return {
      channel: 'tiktok' as 'tiktok',
        success:       true,
        platformId:    `tt_${payload.campaignId}_${Date.now()}`,
        simulatedRoas,
        message:       `TikTok Ads ${action} simulated OK`,
      };
    } catch (err) {
      this.log.error(`[TikTok] execution failed: ${(err as Error).message}`);
      return { success: false, channel: 'tiktok', message: (err as Error).message };
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private simulateRoas(action: string, budget: number): number {
    // Placeholder until real TikTok Business API integration
    // Real impl: POST /open_api/v1.3/campaign/create/ with access_token
    const base = action === 'SCALE' ? 3.5 : action === 'CREATE' ? 3.0 : 1.0;
    return parseFloat((base + (Math.random() * 0.5 - 0.25)).toFixed(2));
  }
}
