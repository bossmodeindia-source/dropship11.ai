import { Module } from '@nestjs/common';
import { ProviderRequestService } from './provider-request.service';
import { ProviderRequestController } from './provider-request.controller';
import { ProviderRequestAdminController } from './provider-request-admin.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [ProviderRequestService],
  controllers: [ProviderRequestController, ProviderRequestAdminController],
  exports: [ProviderRequestService],
})
export class ProviderRequestModule {}
