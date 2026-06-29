import { Module } from '@nestjs/common';
import { AdminFulfillmentWorkspaceController } from './admin-fulfillment-workspace.controller';
import { SupplierFulfillmentModule } from '../supplier-fulfillment/supplier-fulfillment.module';
import { EscrowModule }  from '../escrow/escrow.module';
import { AuditModule }   from '../audit/audit.module';

@Module({
  imports:     [SupplierFulfillmentModule, EscrowModule, AuditModule],
  controllers: [AdminFulfillmentWorkspaceController],
})
export class AdminFulfillmentModule {}
