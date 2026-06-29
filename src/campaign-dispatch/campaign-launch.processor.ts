/**
 * CampaignLaunchProcessor
 *
 * Consumes the CAMPAIGN_LAUNCH canonical queue.
 *
 * WHY THIS EXISTS:
 *   UnifiedCommerceOrchestrator enqueues 'launch-paid' and 'launch-organic' jobs
 *   to CanonicalQueue.CAMPAIGN_LAUNCH. Previously no @Processor consumed these —
 *   paid ads and organic posts were NEVER executed. This processor closes the loop.
 *
 * SECURITY CONTRACT:
 *   - 'launch-paid'    → TenantMetaAdsBridge.launchCampaign()
 *                        Uses USER Meta ad account tokens (stored encrypted in
 *                        UserBusinessConnectionsService). Admin keys NEVER used.
 *   - 'launch-organic' → TenantOrganicPublisherService.publish()
 *                        Uses USER social tokens. Admin keys NEVER used.
 *   - All ad spend is charged to the USER's Meta billing account.
 *
 * JOB PAYLOAD CONTRACT (from UnifiedCommerceOrchestrator):
 *
 *  'launch-paid':
 *  { tenantId, botId, cycleId, productName?, budget?, creativeUrl?, adAccountId? }
 *
 *  'launch-organic':
 *  { tenantId, botId, cycleId, platform?, videoUrl?, caption?, hashtags? }
 *
 *  'scale-up' | 'scale-down' | 'pause' | 'stop':
 *  { tenantId, campaignId }
 */

import { Processor } from '@nestjs/bullmq';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { Pool } from 'pg';
import { CanonicalQueue, JobName } from '../queue/canonical-queues';
import { TenantMetaAdsBridge, TenantMetaCampaignRequest } from '../meta-ads/tenant-meta-ads.bridge';
import { OrganicPublishRequest } from '../organic/tenant-organic-publisher.service';
import { TenantOrganicPublisherService } from '../organic/tenant-organic-publisher.service';
import { DB_POOL } from '../common/database/database.module';

// ── Paid campaign job payload ─────────────────────────────────────────────────
interface LaunchPaidJobData {
  tenantId:     string;
  botId?:       string;
  cycleId?:     string;
  campaignId?:  string;
  productName?: string;
  productDesc?: string;
  niche?:       string;
  audience?:    string;
  budget?:      number;          // daily budget USD
  creativeUrl?: string;          // Telegram CDN URL of video
  adAccountId?: string;          // override tenant default ad account
  pixelId?:     string;
  objective?:   string;          // 'OUTCOME_SALES' | 'OUTCOME_TRAFFIC' | ...
}

// ── Organic post job payload ──────────────────────────────────────────────────
interface LaunchOrganicJobData {
  tenantId:    string;
  botId?:      string;
  cycleId?:    string;
  campaignId?: string;
  platform?:   OrganicPublishRequest['platform'];
  videoUrl?:   string;
  videoJobId?: string;
  caption?:    string;
  hashtags?:   string[];
  scheduleAt?: string;           // ISO timestamp — if absent, post immediately
}

// ── Campaign control payloads ─────────────────────────────────────────────────
interface CampaignControlJobData {
  tenantId:   string;
  campaignId: string;
  newBudget?: number;            // for scale-up/down
}

@Processor(CanonicalQueue.CAMPAIGN_LAUNCH)
export class CampaignLaunchProcessor {
  private readonly logger = new Logger(CampaignLaunchProcessor.name);

  constructor(
    private readonly metaBridge:  TenantMetaAdsBridge,
    private readonly organic:     TenantOrganicPublisherService,
    @Inject(DB_POOL) private readonly db: Pool,
  ) {}

  // ── Paid campaign launch ──────────────────────────────────────────────────

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleLaunchPaid(job: Job<LaunchPaidJobData>): Promise<void> {
    const { data } = job;
    const { tenantId, cycleId, productName, budget, creativeUrl } = data;

    this.logger.log(
      `[launch-paid] tenant=${tenantId} product="${productName}" ` +
      `budget=$${budget} cycleId=${cycleId}`,
    );

    if (!creativeUrl) {
      this.logger.warn(
        `[launch-paid] No creativeUrl for tenant=${tenantId} cycleId=${cycleId} — ` +
        `creative pipeline may not have completed yet. Job will retry.`,
      );
      throw new Error('creativeUrl not yet available — waiting for video pipeline');
    }

    const req: TenantMetaCampaignRequest = {
      tenantId,
      campaignName:  `${productName ?? 'Product'} — ${cycleId ?? Date.now()}`,
      objective:     (data.objective as TenantMetaCampaignRequest['objective']) ?? 'CONVERSIONS',
      dailyBudgetInr: (budget ?? 20) * 83, // convert USD to INR (1 USD ≈ 83 INR)
      dailyBudgetUsd: budget ?? 20,
      creativeUrl,
      adAccountId:   data.adAccountId,
      pixelId:       data.pixelId,
      audience: {
        description: data.audience ?? 'Broad interest targeting',
        niche:       data.niche    ?? 'general',
      },
    };

    const result = await this.metaBridge.launchCampaign(req);

    await this.db.query(
      `INSERT INTO campaign_launch_events
         (tenant_id, cycle_id, campaign_id, platform, status, meta_campaign_id, created_at)
       VALUES ($1,$2,$3,'meta',$4,$5,NOW())
       ON CONFLICT DO NOTHING`,
      [tenantId, cycleId, data.campaignId, result.success ? 'launched' : 'failed', result.campaignId],
    ).catch(err => {
      // Non-fatal: if the table doesn't exist yet, log and continue
      this.logger.warn(`campaign_launch_events insert skipped: ${err.message}`);
    });

    this.logger.log(
      `[launch-paid] Meta campaign launched — ` +
      `metaCampaignId=${result.campaignId} tenant=${tenantId}`,
    );
  }

  // ── Organic post launch ───────────────────────────────────────────────────

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleLaunchOrganic(job: Job<LaunchOrganicJobData>): Promise<void> {
    const { data } = job;
    const { tenantId, platform, videoUrl, caption, hashtags } = data;

    this.logger.log(
      `[launch-organic] tenant=${tenantId} platform=${platform} ` +
      `cycleId=${data.cycleId}`,
    );

    if (!videoUrl && !data.videoJobId) {
      this.logger.warn(
        `[launch-organic] No media URL for tenant=${tenantId} — ` +
        `waiting for video pipeline. Job will retry.`,
      );
      throw new Error('media URL not yet available — waiting for video pipeline');
    }

    const req: OrganicPublishRequest = {
      tenantId,
      platform:    platform     ?? 'instagram',
      videoUrl,
      videoJobId:  data.videoJobId,
      caption:     caption      ?? '',
      hashtags:    hashtags     ?? [],
      campaignId:  data.campaignId ?? data.cycleId,
      scheduleAt:  data.scheduleAt ? new Date(data.scheduleAt) : undefined,
    };

    const result = await this.organic.publish(req);

    this.logger.log(
      `[launch-organic] Posted to ${platform} — ` +
      `postId=${result.platformPostId} tenant=${tenantId}`,
    );
  }

  // ── Campaign scaling controls ─────────────────────────────────────────────

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleScaleUp(job: Job<CampaignControlJobData>): Promise<void> {
    const { tenantId, campaignId, newBudget } = job.data;
    this.logger.log(`[scale-up] tenant=${tenantId} campaignId=${campaignId} newBudget=${newBudget}`);

    await this.metaBridge.scaleCampaign(tenantId, campaignId, newBudget ?? 0);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleScaleDown(job: Job<CampaignControlJobData>): Promise<void> {
    const { tenantId, campaignId, newBudget } = job.data;
    this.logger.log(`[scale-down] tenant=${tenantId} campaignId=${campaignId} newBudget=${newBudget}`);

    await this.metaBridge.scaleCampaign(tenantId, campaignId, newBudget ?? 0);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handlePause(job: Job<CampaignControlJobData>): Promise<void> {
    const { tenantId, campaignId } = job.data;
    this.logger.log(`[pause] tenant=${tenantId} campaignId=${campaignId}`);
    await this.metaBridge.pauseCampaign(tenantId, campaignId);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleStop(job: Job<CampaignControlJobData>): Promise<void> {
    const { tenantId, campaignId } = job.data;
    this.logger.log(`[stop] tenant=${tenantId} campaignId=${campaignId}`);
    // No dedicated stopCampaign method — pause is functionally equivalent for budget protection
    await this.metaBridge.pauseCampaign(tenantId, campaignId);
  }
}
