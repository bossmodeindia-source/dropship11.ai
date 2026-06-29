/**
 * ChannelRouterService — V52 Multi-Channel Router
 *
 * Routes campaign execution to the correct channelId adapter.
 * Called ONLY from within RCCSKernel after all safety gates pass.
 *
 * Routing:
 *   meta   → existing ZeroLossKernel path (no change — kernel handles meta)
 *   google → GoogleAdsChannelAdapter
 *   tiktok → TikTokAdsChannelAdapter
 *
 * SAFETY: Never bypasses RCCSKernel. Never calls external APIs directly.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleAdsChannelAdapter } from './google/google-ads.adapter';
import { TikTokAdsChannelAdapter } from './tiktok/tiktok-ads.adapter';
import { ChannelType, ChannelCampaignPayload, ChannelExecutionResult } from './channel.interface';

export { ChannelType };

@Injectable()
export class ChannelRouterService {
  private readonly log = new Logger(ChannelRouterService.name);

  constructor(
    private readonly google: GoogleAdsChannelAdapter,
    private readonly tiktok: TikTokAdsChannelAdapter,
  ) {}

  /**
   * Route action to correct channel adapter.
   * Meta channel returns null — caller falls through to ZeroLossKernel.
   */
  async route(req: any): Promise<ChannelExecutionResult | null> {
    const { channel, action, payload } = req ?? {};
    switch (channel) {
      case 'meta':
        // Meta execution handled by existing V15/V16 kernel path
        this.log.debug(`[Router] meta → existing kernel path (campaign=${payload.campaignId})`);
        return null;

      case 'google':
        this.log.log(`[Router] → GoogleAds action=${action} campaign=${payload.campaignId}`);
        return this.google.executeCampaign(action, payload);

      case 'tiktok':
        this.log.log(`[Router] → TikTok action=${action} campaign=${payload.campaignId}`);
        return this.tiktok.executeCampaign(action, payload);

      default:
        this.log.warn(`[Router] unknown channel=${channel} — defaulting to meta path`);
        return null;
    }
  }

  /**
   * Select best channel for a campaign based on predicted ROAS.
   * Used by V29 StrategyEngine and V52 channel selection logic.
   *
   * Rules:
   *   predictedRoas ≥ 3.5 → tiktok (high-engagement short-form)
   *   predictedRoas ≥ 2.5 → google (search intent, conversion-ready)
   *   predictedRoas < 2.5 → meta   (broad reach, retargeting)
   */
  selectBestChannel(predictedRoas: number): ChannelType {
    if (predictedRoas >= 3.5) return 'tiktok';
    if (predictedRoas >= 2.5) return 'google';
    return 'meta';
  }
}
