import { Module } from '@nestjs/common';
import { OrganicService } from './organic.service';
import { OrganicController } from './organic.controller';
import { OrganicSchedulerV61 } from './organic-scheduler-v61.service';
import { TenantOrganicPublisherService } from './tenant-organic-publisher.service';
import { HashtagGeneratorService } from './hashtag-generator.service';
import { InstagramPlatformAdapter } from './platforms/instagram.adapter';
import { FacebookPlatformAdapter } from './platforms/facebook.adapter';
import { TikTokAdapter } from './platforms/tiktok.adapter';
import { YouTubeShortsAdapter } from './platforms/youtube-shorts.adapter';
import { UserBusinessConnectionsModule } from '../user-business-connections/user-business-connections.module';
import { TelegramStorageModule } from '../telegram-storage/telegram-storage.module';
import { DatabaseModule } from '../common/database/database.module';
import { AdCreativesModule } from '../ad-creatives/ad-creatives.module';
import { CreativeViralityModule } from '../creative-virality/creative-virality.module';

@Module({
  imports: [DatabaseModule, UserBusinessConnectionsModule, TelegramStorageModule, AdCreativesModule, CreativeViralityModule],
  providers: [
    OrganicService,
    OrganicSchedulerV61,
    TenantOrganicPublisherService,
    HashtagGeneratorService,
    InstagramPlatformAdapter,
    FacebookPlatformAdapter,
    TikTokAdapter,
    YouTubeShortsAdapter,
  ],
  controllers: [OrganicController],
  exports: [OrganicService, TenantOrganicPublisherService, TikTokAdapter, YouTubeShortsAdapter],
})
export class OrganicModule {}
