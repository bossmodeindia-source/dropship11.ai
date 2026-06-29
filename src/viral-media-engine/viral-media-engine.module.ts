import { Module }                    from '@nestjs/common';
import { BullModule }                from '@nestjs/bullmq';
import { ViralMediaEngineService }   from './viral-media-engine.service';
import { ViralMediaEngineController } from './viral-media-engine.controller';
import { CommerceBrainModule }       from '../commerce-brain/commerce-brain.module';
import { TrendIntelligenceModule }   from '../trend-intelligence/trend-intelligence.module';
import { VideoPipelineModule }       from '../video-pipeline/video-pipeline.module';
import { CreativeViralityModule }    from '../creative-virality/creative-virality.module';
import { TelegramStorageModule }     from '../telegram-storage/telegram-storage.module';
import { DatabaseModule }            from '../common/database/database.module';
import { MetricsModule }             from '../metrics/metrics.module';
import { AuditModule }               from '../audit/audit.module';
import { CanonicalQueue }            from '../queue/canonical-queues';

@Module({
  imports: [
    DatabaseModule,
    CommerceBrainModule,
    TrendIntelligenceModule,
    VideoPipelineModule,
    CreativeViralityModule,
    TelegramStorageModule,
    MetricsModule,
    AuditModule,
    BullModule.registerQueue({ name: CanonicalQueue.CREATIVE_GENERATION }),
  ],
  providers:   [ViralMediaEngineService],
  controllers: [ViralMediaEngineController],
  exports:     [ViralMediaEngineService],
})
export class ViralMediaEngineModule {}
