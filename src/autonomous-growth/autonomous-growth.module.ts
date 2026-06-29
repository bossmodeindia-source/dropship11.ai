// autonomous-growth.module.ts
import { Module } from '@nestjs/common';
import { AutonomousGrowthService }    from './autonomous-growth.service';
import { AutonomousGrowthController } from './autonomous-growth.controller';
import { CommerceAnalyticsModule }    from '../commerce-analytics/commerce-analytics.module';
import { CustomerLifecycleModule }    from '../customer-lifecycle/customer-lifecycle.module';
import { RevenueOptimizationModule }  from '../revenue-optimization/revenue-optimization.module';
import { AiOrchestratorModule }       from '../ai-orchestrator/ai-orchestrator.module';
import { AuditModule }                from '../audit/audit.module';
import { AlertingModule }             from '../alerting/alerting.module';

@Module({
  imports: [
    AiOrchestratorModule,
    CommerceAnalyticsModule,
    CustomerLifecycleModule,
    RevenueOptimizationModule,
    AuditModule,
    AlertingModule,
  ],
  providers:   [AutonomousGrowthService],
  controllers: [AutonomousGrowthController],
  exports:     [AutonomousGrowthService],
})
export class AutonomousGrowthModule {}
