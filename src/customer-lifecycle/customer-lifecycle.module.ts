import { Module } from '@nestjs/common';
import { CustomerLifecycleService } from './customer-lifecycle.service';
import { CustomerLifecycleController } from './customer-lifecycle.controller';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';

@Module({
  imports:     [AiOrchestratorModule],
  providers:   [CustomerLifecycleService],
  controllers: [CustomerLifecycleController],
  exports:     [CustomerLifecycleService],
})
export class CustomerLifecycleModule {}
