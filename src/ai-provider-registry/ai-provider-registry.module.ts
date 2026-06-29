import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AiProviderRegistryService } from './ai-provider-registry.service';
import {
  AiProviderRegistryController,
  AiProviderPublicController,
} from './ai-provider-registry.controller';
import { ProviderHealthMonitorService } from './provider-health-monitor.service';
import { AuditModule } from '../audit/audit.module';
import { AlertingModule } from '../alerting/alerting.module';

@Module({
  imports: [ScheduleModule.forRoot(), AuditModule, AlertingModule],
  providers: [AiProviderRegistryService, ProviderHealthMonitorService],
  controllers: [AiProviderRegistryController, AiProviderPublicController],
  exports: [AiProviderRegistryService],
})
export class AiProviderRegistryModule {}
