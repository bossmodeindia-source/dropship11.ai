/**
 * CommerceBrainModule
 *
 * Registers all 13 AI brain subsystems as a @Global injectable module.
 * Any module that needs CommerceBrainService can import this module.
 *
 * CommerceBrainService IS the AutonomousAgentCoordinator — it routes
 * each request to the correct Brain subsystem and assembles CommercePlans.
 */

import { Module, Global }      from '@nestjs/common';
import { CommerceBrainService } from './commerce-brain.service';
import { CommerceBrainController } from './commerce-brain.controller';
import { AiOrchestratorModule }  from '../ai-orchestrator/ai-orchestrator.module';
import { DatabaseModule }        from '../common/database/database.module';
import { MetricsModule }         from '../metrics/metrics.module';
import { AuditModule }           from '../audit/audit.module';
import { AlertingModule }        from '../alerting/alerting.module';

@Global()
@Module({
  imports: [
    DatabaseModule,
    AiOrchestratorModule,
    MetricsModule,
    AuditModule,
    AlertingModule,
  ],
  providers:   [CommerceBrainService],
  controllers: [CommerceBrainController],
  exports:     [CommerceBrainService],
})
export class CommerceBrainModule {}
