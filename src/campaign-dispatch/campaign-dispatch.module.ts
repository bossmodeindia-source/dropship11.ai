/**
 * CampaignDispatchModule
 *
 * Registers the processors that consume the two critical canonical queues
 * that had ZERO consumers in V61:
 *
 *   CanonicalQueue.CAMPAIGN_LAUNCH  → CampaignLaunchProcessor
 *     Handles: launch-paid, launch-organic, scale-up, scale-down, pause, stop
 *
 *   CanonicalQueue.ORGANIC_POSTING  → OrganicPostingProcessor
 *     Handles: post (direct post jobs enqueued by TenantOrganicPublisherService)
 *
 * The QueueModule (@Global) already registers both queues — this module
 * only provides the @Processor-decorated consumers.
 *
 * MetaAdsModule and OrganicModule are imported here so their services can
 * be injected into the processors. Both modules export their services.
 */

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CanonicalQueue } from '../queue/canonical-queues';
import { CampaignLaunchProcessor } from './campaign-launch.processor';
import { OrganicPostingProcessor } from './organic-posting.processor';
import { MetaAdsModule } from '../meta-ads/meta-ads.module';
import { OrganicModule } from '../organic/organic.module';

@Module({
  imports: [
    MetaAdsModule,
    OrganicModule,
    // Register the queues this module processes.
    // QueueModule is @Global so the underlying Redis connections already exist;
    // registerQueue() here simply creates the Bull Queue token for injection.
    BullModule.registerQueue(
      { name: CanonicalQueue.CAMPAIGN_LAUNCH },
      { name: CanonicalQueue.ORGANIC_POSTING },
    ),
  ],
  providers: [
    CampaignLaunchProcessor,
    OrganicPostingProcessor,
  ],
})
export class CampaignDispatchModule {}
