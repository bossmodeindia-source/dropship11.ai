import { Module }                    from '@nestjs/common';
import { BullModule }                from '@nestjs/bullmq';
import { TrendIntelligenceService }  from './trend-intelligence.service';
import { TrendIntelligenceController } from './trend-intelligence.controller';
import { AiOrchestratorModule }      from '../ai-orchestrator/ai-orchestrator.module';
import { CommerceBrainModule }       from '../commerce-brain/commerce-brain.module';
import { DatabaseModule }            from '../common/database/database.module';
import { MetricsModule }             from '../metrics/metrics.module';
import { AlertingModule }            from '../alerting/alerting.module';
import { CanonicalQueue }            from '../queue/canonical-queues';

@Module({
  imports: [
    DatabaseModule,
    AiOrchestratorModule,
    CommerceBrainModule,
    MetricsModule,
    AlertingModule,
    BullModule.registerQueue({ name: CanonicalQueue.ANALYTICS }),
  ],
  providers:   [TrendIntelligenceService],
  controllers: [TrendIntelligenceController],
  exports:     [TrendIntelligenceService],
})
export class TrendIntelligenceModule {}
