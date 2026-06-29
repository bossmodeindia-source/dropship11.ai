/**
 * PlatformAdsService
 *
 * Orchestrator for the complete Platform Growth Engine.
 * Runs the automated optimization loop:
 *
 *   Generate creative → Score → Create campaign → Launch Meta ads
 *   → Track performance → Optimize → Scale or kill
 *   → Track signups → Track subscriptions → Update SaaS metrics
 *
 * Scheduled by PlatformAdsScheduler (cron).
 * All operations are admin-only.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { platformCampaigns } from './platform-ads.schema';
import { PlatformCampaignService } from './platform-campaign.service';
import { PlatformAnalyticsService } from './platform-analytics.service';
import { PlatformRetargetingService } from './platform-retargeting.service';
import { AlertingService } from '../alerting/alerting.service';

// Platform-specific queue names (isolated from user commerce queues)
export const PLATFORM_QUEUES = {
  CREATIVE_GENERATION: 'platform-creative-generation',
  CAMPAIGN_LAUNCH:     'platform-campaign-launch',
  RETARGETING:         'platform-retargeting',
  ANALYTICS_SYNC:      'platform-analytics-sync',
  ALERTS:              'platform-alerts',
} as const;

@Injectable()
export class PlatformAdsService {
  private readonly logger = new Logger(PlatformAdsService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly campaigns:    PlatformCampaignService,
    private readonly analytics:    PlatformAnalyticsService,
    private readonly retargeting:  PlatformRetargetingService,
    private readonly alerting:     AlertingService,
  ) {}

  // ── Scheduled: run AI optimization loop every 6 hours ────────────────────

  @Cron('0 */6 * * *')
  async runOptimizationLoop(): Promise<void> {
    this.logger.log('Platform optimization loop starting');

    try {
      // 1. Enforce spend cap first
      await this.campaigns.enforceSpendCap();

      // 2. Evaluate and apply scaling decisions for all active campaigns
      const active = await this.db
        .select()
        .from(platformCampaigns)
        .where(eq(platformCampaigns.status, 'ACTIVE'));

      for (const campaign of active) {
        try {
          const decision = await this.campaigns.evaluateScaling(campaign.id);
          this.logger.log(
            `Campaign ${campaign.id} scaling decision: ${decision.action} — ${decision.reason}`,
          );
          await this.campaigns.applyScalingDecision(campaign.id, decision);
        } catch (err) {
          this.logger.error(
            `Scaling evaluation failed for campaign ${campaign.id}: ${(err as Error).message}`,
          );
        }
      }

      this.logger.log(`Optimization loop complete. Evaluated ${active.length} campaigns.`);
    } catch (err) {
      this.logger.error(`Optimization loop error: ${(err as Error).message}`);
      await this.alerting.sendWarn({
        title:   'Platform Optimization Loop Error',
        message: (err as Error).message,
      });
    }
  }

  // ── Scheduled: daily growth analytics snapshot at midnight ───────────────

  @Cron('0 0 * * *')
  async runDailySnapshot(): Promise<void> {
    try {
      await this.analytics.snapshotDailyGrowth();
      this.logger.log('Daily platform growth snapshot saved');
    } catch (err) {
      this.logger.error(`Daily snapshot failed: ${(err as Error).message}`);
    }
  }

  // ── Scheduled: build retargeting audiences every 12 hours ────────────────

  @Cron('0 */12 * * *')
  async runRetargetingSync(): Promise<void> {
    try {
      await this.retargeting.launchRetargetingCampaigns();
      this.logger.log('Retargeting sync complete');
    } catch (err) {
      this.logger.error(`Retargeting sync failed: ${(err as Error).message}`);
    }
  }

  // ── Manual admin operations ───────────────────────────────────────────────

  async getDashboard() {
    return this.analytics.getDashboard();
  }

  async pauseAll(reason: string): Promise<void> {
    await this.campaigns.pauseAllCampaigns(reason);
    await this.alerting.sendCritical({
      title:   '⏸️ All Platform Campaigns Paused',
      message: `All platform ads paused by admin: ${reason}`,
    });
  }
}
