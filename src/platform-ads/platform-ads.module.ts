/**
 * PlatformAdsModule — V60 PATCHED
 *
 * Fixes applied:
 *   [H7] AiCreativeProviderService is no longer instantiated as a local provider.
 *        It is now imported from AdCreativesModule via its exports.
 *        BEFORE: two instances existed (split state — AI provider config set in one
 *                instance was invisible to the other).
 *        AFTER:  single shared instance from AdCreativesModule (AdCreativesModule
 *                must export AiCreativeProviderService — see ad-creatives.module.ts patch).
 *
 *   [H6] All 5 BullMQ processor workers are now registered as providers.
 *        BEFORE: queues were registered but had no @Processor implementations —
 *                jobs queued silently and never executed.
 *        AFTER:  5 processors (CreativeGeneration, CampaignLaunch, Retargeting,
 *                AnalyticsSync, Alerts) are wired in.
 *
 *   ConfigService is now explicitly imported (required by PlatformCampaignService,
 *   PlatformAnalyticsService, PlatformRetargetingService after H3/H4/H6 fixes).
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

// ── Reused modules (not duplicated) ──────────────────────────────────────────
import { MetaAdsModule }  from '../meta-ads/meta-ads.module';
import { AlertingModule } from '../alerting/alerting.module';
// [H7 FIX] Import from AdCreativesModule — do not re-declare AiCreativeProviderService
import { AdCreativesModule } from '../ad-creatives/ad-creatives.module';

// ── Platform Ads services ─────────────────────────────────────────────────────
import { PlatformAdsController }    from './platform-ads.controller';
import { PlatformAdsService }       from './platform-ads.service';
import { PlatformCampaignService }  from './platform-campaign.service';
import { PlatformCreativeService }  from './platform-creative.service';
import { PlatformAnalyticsService } from './platform-analytics.service';
import { PlatformRetargetingService } from './platform-retargeting.service';

// ── [H6 FIX] Import processor workers ────────────────────────────────────────
import {
  PlatformCreativeGenerationProcessor,
  PlatformCampaignLaunchProcessor,
  PlatformRetargetingProcessor,
  PlatformAnalyticsSyncProcessor,
  PlatformAlertsProcessor,
  PLATFORM_QUEUE_NAMES,
} from './workers/platform-ads.processors';

@Module({
  imports: [
    ConfigModule,        // provides ConfigService to all platform-ads services
    MetaAdsModule,       // provides MetaApiClient
    AlertingModule,      // provides AlertingService
    // [H7 FIX] AiCreativeProviderService comes from here — single shared instance
    AdCreativesModule,
    // Register all 5 platform-specific BullMQ queues
    BullModule.registerQueue(
      { name: PLATFORM_QUEUE_NAMES.CREATIVE_GENERATION },
      { name: PLATFORM_QUEUE_NAMES.CAMPAIGN_LAUNCH },
      { name: PLATFORM_QUEUE_NAMES.RETARGETING },
      { name: PLATFORM_QUEUE_NAMES.ANALYTICS_SYNC },
      { name: PLATFORM_QUEUE_NAMES.ALERTS },
    ),
  ],
  controllers: [PlatformAdsController],
  providers: [
    // ── Core services ──────────────────────────────────────────────────────
    PlatformAdsService,
    PlatformCampaignService,
    PlatformCreativeService,
    PlatformAnalyticsService,
    PlatformRetargetingService,

    // ── [H6 FIX] BullMQ processors — all 5 queues now have workers ────────
    PlatformCreativeGenerationProcessor,
    PlatformCampaignLaunchProcessor,
    PlatformRetargetingProcessor,
    PlatformAnalyticsSyncProcessor,
    PlatformAlertsProcessor,

    // ── NOTE: AiCreativeProviderService intentionally REMOVED from here ───
    // [H7] It is injected via AdCreativesModule.exports to prevent split state.
  ],
  exports: [
    PlatformAdsService,
    PlatformAnalyticsService,
  ],
})
export class PlatformAdsModule {}
