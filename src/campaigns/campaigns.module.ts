import { Module } from '@nestjs/common';
import { CampaignsController  } from './campaigns.controller';
import { CampaignsService     } from './campaigns.service';
import { StrategyService      } from './strategy.service';
import { AuditModule          } from '../audit/audit.module';
import { AiMediaModule        } from '../ai-media/ai-media.module';
import { WorkersModule        } from '../workers/workers.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';

@Module({
  imports: [
    AuditModule,
    AiMediaModule,
    WorkersModule,        // exports AiJobService for async campaign jobs
    AiOrchestratorModule, // exports AiOrchestratorService for StrategyService
  ],
  controllers: [CampaignsController],
  providers:   [CampaignsService, StrategyService],
  exports:     [StrategyService],
})
export class CampaignsModule {}
