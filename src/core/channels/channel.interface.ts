/**
 * IAdChannel — V52 Multi-Channel Abstraction
 *
 * Implemented by every channel adapter (Meta, Google, TikTok).
 * ALL mutations route through RCCSKernel — adapters NEVER call
 * external APIs directly; they simulate or proxy via kernel context.
 */

export type ChannelType = 'meta' | 'google' | 'tiktok';

export interface ChannelCampaignPayload {
  campaignId:    string;
  name:          string;
  budget:        number;        // INR/USD — adapter normalises
  channel:       ChannelType;
  metadata?:     Record<string, unknown>;
}

export interface ChannelExecutionResult {
  success:       boolean;
  channel:       ChannelType;
  platformId?:   string;        // platform-assigned campaign/ad-set ID
  simulatedRoas?: number;
  message?:      string;
}

export interface IAdChannel {
  /**
   * Execute a campaign action (CREATE | SCALE | PAUSE | KILL) on this channel.
   * Called ONLY from within RCCSKernel execution context.
   */
  executeCampaign(
    action:  'CREATE' | 'SCALE' | 'PAUSE' | 'KILL',
    payload: ChannelCampaignPayload,
  ): Promise<ChannelExecutionResult>;

  /** Canonical platform name — used for routing & logging */
  getPlatformName(): ChannelType;
}
