// revenue-optimization.module.ts
import { Module } from '@nestjs/common';
import { RevenueOptimizationService }    from './revenue-optimization.service';
import { RevenueOptimizationController } from './revenue-optimization.controller';
import { AiOrchestratorModule }          from '../ai-orchestrator/ai-orchestrator.module';

@Module({
  imports:     [AiOrchestratorModule],
  providers:   [RevenueOptimizationService],
  controllers: [RevenueOptimizationController],
  exports:     [RevenueOptimizationService],
})
export class RevenueOptimizationModule {}
