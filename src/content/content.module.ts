import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../common/database/database.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { ContentEngine } from './content.engine';
import { ContentController } from './content.controller';

@Module({
  imports: [DatabaseModule, AiOrchestratorModule, ScheduleModule.forRoot()],
  providers: [ContentEngine],
  controllers: [ContentController],
  exports: [ContentEngine],
})
export class ContentModule {}
