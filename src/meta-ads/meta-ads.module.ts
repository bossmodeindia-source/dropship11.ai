import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MetaAdsService } from './meta-ads.service';
import { MetaAdsController } from './meta-ads.controller';
import { MetaApiClient } from './meta-api.client';
import { MetaPerformanceService } from './performance/meta-performance.service';
import { MetaPerformanceScheduler } from './performance/meta-performance.scheduler';
import { MetaPerformanceController } from './performance/meta-performance.controller';
import { MetaAdsExtensionService } from './meta-ads-extension.service';
import { TenantMetaAdsBridge } from './tenant-meta-ads.bridge';
import { AdCreativesModule } from '../ad-creatives/ad-creatives.module';
import { AiMediaModule } from '../ai-media/ai-media.module';
import { UserBusinessConnectionsModule } from '../user-business-connections/user-business-connections.module';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../common/database/database.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AdCreativesModule,
    AiMediaModule,
    UserBusinessConnectionsModule,
    AuditModule,
    DatabaseModule,
  ],
  controllers: [MetaAdsController, MetaPerformanceController],
  providers: [
    MetaAdsService, MetaApiClient,
    MetaPerformanceService, MetaPerformanceScheduler,
    MetaAdsExtensionService, TenantMetaAdsBridge,
  ],
  exports: [
    MetaAdsService, MetaPerformanceService,
    MetaAdsExtensionService, MetaApiClient, TenantMetaAdsBridge,
  ],
})
export class MetaAdsModule {}
