import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { InfluencerService } from './influencer.service';
import { InfluencerController } from './influencer.controller';

@Module({
  imports: [DatabaseModule, AiOrchestratorModule],
  providers: [InfluencerService],
  controllers: [InfluencerController],
  exports: [InfluencerService],
})
export class InfluencerModule {}
