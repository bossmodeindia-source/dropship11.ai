/**
 * TenantMetaAdsBridge
 *
 * Executes Meta Ad campaigns using USER-OWNED Meta credentials.
 * The platform NEVER uses admin Meta tokens for user ad campaigns.
 *
 * ALL ad spend flows through user's own:
 *  - META_ACCESS_TOKEN (user's own token)
 *  - META_AD_ACCOUNT_ID (user's own ad account — billing to user's payment method)
 *  - META_PIXEL_ID (user's own conversion pixel)
 *  - FACEBOOK_PAGE_ID (user's own page for ad creative)
 *
 * This service wraps the existing MetaApiClient by injecting
 * tenant-specific credentials at call time via UserBusinessConnectionsService.
 */

import {
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import { UserBusinessConnectionsService } from '../user-business-connections/user-business-connections.service';
import { AuditService } from '../audit/audit.service';

export interface TenantMetaCampaignRequest {
  tenantId:          string;
  campaignName:      string;
  objective:         'CONVERSIONS' | 'TRAFFIC' | 'AWARENESS' | 'ENGAGEMENT' | 'OUTCOME_SALES';
  /** Daily budget in INR — platform converts to USD cents for Meta API */
  dailyBudgetInr:    number;
  /** Daily budget in USD — alternative to dailyBudgetInr; one must be supplied */
  dailyBudgetUsd?:   number;
  /** Targeting config. When omitted, bridge uses broad interest targeting. */
  targeting?:        Record<string, unknown>;
  /** Structured audience override (used by campaign-launch processor) */
  audience?:         { description: string; niche: string };
  creativeImageUrl?: string;
  creativeVideoUrl?: string;
  /** Assembled video ad URL (used by campaign-launch processor) */
  creativeUrl?:      string;
  adCopy?:           string;
  headline?:         string;
  ctaType?:          string;
  shopifyProductUrl?: string;
  pixelId?:          string;
  adAccountId?:      string;
  pixelEventName?:   string;
}

export interface TenantMetaCampaignResult {
  campaignId:  string;
  adSetId:     string;
  adId:        string;
  status:      'ACTIVE' | 'PAUSED' | 'failed';
  adAccountId: string;
  error?:      string;
  /** Convenience: true when status !== 'failed' */
  readonly success: boolean;
}

const META_GRAPH_API = 'https://graph.facebook.com/v21.0';
const INR_TO_USD_CENTS = 0.012 * 100; // 1 INR = 0.012 USD → * 100 = cents

@Injectable()
export class TenantMetaAdsBridge {
  private readonly logger = new Logger(TenantMetaAdsBridge.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly bizConnections: UserBusinessConnectionsService,
    private readonly audit:          AuditService,
  ) {}

  // ── Launch a campaign using user's own Meta account ───────────────────────

  async launchCampaign(req: TenantMetaCampaignRequest): Promise<TenantMetaCampaignResult> {
    // Get user's Meta credentials
    const creds = await this.bizConnections.decryptForRuntime(req.tenantId, 'meta_ads');

    const token     = creds.primaryToken!;
    const adAcctId  = creds.accountId!;   // format: act_XXXXXXXXXX
    const pixelId   = creds.pixelId;
    const pageId    = creds.secondaryToken; // we store page token + page ID

    // Convert INR budget to USD cents (Meta API requires cents)
    const dailyBudgetCents = Math.round(req.dailyBudgetInr * INR_TO_USD_CENTS);
    const minBudget = 100; // $1.00 minimum
    const budget    = Math.max(minBudget, dailyBudgetCents);

    this.logger.log(
      `[TenantMeta] Launching campaign for tenant ${req.tenantId} ` +
      `on account ${adAcctId}, budget: ${budget} cents/day`,
    );

    try {
      // ── Step 1: Create campaign ──────────────────────────────────────────
      const campaign = await this.metaPost(
        `/${adAcctId}/campaigns`,
        token,
        {
          name:                   req.campaignName,
          objective:              req.objective,
          status:                 'ACTIVE',
          special_ad_categories:  [],
        },
      );

      // ── Step 2: Create ad set ────────────────────────────────────────────
      const adSetBody: Record<string, unknown> = {
        name:               `${req.campaignName} — AdSet`,
        campaign_id:        campaign.id,
        daily_budget:       budget,
        billing_event:      'IMPRESSIONS',
        optimization_goal:  req.objective === 'CONVERSIONS' ? 'OFFSITE_CONVERSIONS' : 'LINK_CLICKS',
        targeting:          req.targeting,
        status:             'ACTIVE',
        start_time:         Math.floor(Date.now() / 1000),
      };

      if (pixelId && req.objective === 'CONVERSIONS') {
        adSetBody.promoted_object = {
          pixel_id:       pixelId,
          custom_event_type: req.pixelEventName ?? 'PURCHASE',
        };
      }

      const adSet = await this.metaPost(`/${adAcctId}/adsets`, token, adSetBody);

      // ── Step 3: Create ad creative ───────────────────────────────────────
      const storySpec = this.buildObjectStorySpec(req, pageId ?? undefined);
      const creative = await this.metaPost(
        `/${adAcctId}/adcreatives`,
        token,
        {
          name:                  `${req.campaignName} — Creative`,
          object_story_spec:     storySpec,
          degrees_of_freedom_spec: {
            creative_features_spec: {
              standard_enhancements: { enroll_status: 'OPT_OUT' },
            },
          },
        },
      );

      // ── Step 4: Create ad ────────────────────────────────────────────────
      const ad = await this.metaPost(
        `/${adAcctId}/ads`,
        token,
        {
          name:        `${req.campaignName} — Ad`,
          adset_id:    adSet.id,
          creative:    { creative_id: creative.id },
          status:      'ACTIVE',
          tracking_specs: pixelId ? [{
            action_type:  ['offsite_conversion'],
            'fb_pixel':   [pixelId],
          }] : undefined,
        },
      );

      this.audit.log({
        tenantId:   req.tenantId,
        actorId:    req.tenantId,
        action:     'meta_campaign.launched',
        resource:   'meta_campaigns',
        resourceId: campaign.id,
        details: {
          campaignId: campaign.id,
          adSetId:    adSet.id,
          adId:       ad.id,
          adAccountId: adAcctId,
          dailyBudgetCents: budget,
          objective: req.objective,
        },
      });

      return {
        campaignId:  campaign.id,
        adSetId:     adSet.id,
        adId:        ad.id,
        status:      'ACTIVE',
        adAccountId: adAcctId,
        get success() { return true; },
      };

    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(`[TenantMeta] Campaign launch failed for tenant ${req.tenantId}: ${error}`);
      return {
        campaignId:  '',
        adSetId:     '',
        adId:        '',
        status:      'failed',
        adAccountId: '',
        error,
        get success() { return false; },
      };
    }
  }

  // ── Pause a campaign ──────────────────────────────────────────────────────

  async pauseCampaign(tenantId: string, campaignId: string): Promise<void> {
    const creds = await this.bizConnections.decryptForRuntime(tenantId, 'meta_ads');
    await this.metaPost(`/${campaignId}`, creds.primaryToken!, { status: 'PAUSED' });
    this.logger.log(`Paused campaign ${campaignId} for tenant ${tenantId}`);
  }

  // ── Scale a campaign (increase budget) ────────────────────────────────────

  async scaleCampaign(
    tenantId:    string,
    adSetId:     string,
    newBudgetInr: number,
  ): Promise<void> {
    const creds       = await this.bizConnections.decryptForRuntime(tenantId, 'meta_ads');
    const budgetCents = Math.round(newBudgetInr * INR_TO_USD_CENTS);
    await this.metaPost(`/${adSetId}`, creds.primaryToken!, { daily_budget: budgetCents });
    this.logger.log(`Scaled adset ${adSetId} to ${budgetCents} cents for tenant ${tenantId}`);
  }

  // ── Get campaign performance ──────────────────────────────────────────────

  async getCampaignInsights(
    tenantId:   string,
    campaignId: string,
    dateRange:  { since: string; until: string },
  ): Promise<any> {
    const creds = await this.bizConnections.decryptForRuntime(tenantId, 'meta_ads');
    const params = new URLSearchParams({
      fields:       'impressions,clicks,spend,actions,cost_per_action_type,ctr,roas',
      time_range:   JSON.stringify(dateRange),
      access_token: creds.primaryToken!,
    });

    const res = await fetch(
      `${META_GRAPH_API}/${campaignId}/insights?${params}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`Meta insights failed: ${res.status}`);
    return res.json();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildObjectStorySpec(
    req: TenantMetaCampaignRequest,
    pageId?: string,
  ): Record<string, unknown> {
    const linkData: Record<string, unknown> = {
      message:         req.adCopy,
      name:            req.headline,
      link:            req.shopifyProductUrl,
      call_to_action:  { type: req.ctaType ?? 'SHOP_NOW' },
    };

    if (req.creativeImageUrl) linkData.image_url = req.creativeImageUrl;
    if (req.creativeVideoUrl) linkData.video_url = req.creativeVideoUrl;

    return {
      page_id:   pageId ?? process.env.META_PAGE_ID ?? '',
      link_data: linkData,
    };
  }

  private async metaPost(
    path:  string,
    token: string,
    body:  Record<string, unknown>,
  ): Promise<any> {
    const res = await fetch(`${META_GRAPH_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, access_token: token }),
      signal: AbortSignal.timeout(30_000),
    });

    const data: any = await res.json();
    if (!res.ok || data.error) {
      throw new Error(
        `Meta API error on ${path}: ${data.error?.message ?? JSON.stringify(data)}`,
      );
    }
    return data;
  }
}
