import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { AovService } from './aov.service';
import { AovController } from './aov.controller';

@Module({
  imports: [DatabaseModule, AiOrchestratorModule],
  providers: [AovService],
  controllers: [AovController],
  exports: [AovService],
})
export class AovModule {}
