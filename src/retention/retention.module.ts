import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../common/database/database.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { RetentionService } from './retention.service';
import { RetentionController } from './retention.controller';

@Module({
  imports: [DatabaseModule, AiOrchestratorModule, ScheduleModule.forRoot()],
  providers: [RetentionService],
  controllers: [RetentionController],
  exports: [RetentionService],
})
export class RetentionModule {}
