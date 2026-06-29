import { Module, forwardRef } from '@nestjs/common';
import { SupplierFulfillmentService }          from './supplier-fulfillment.service';
import { SupplierCheckoutAutomationService }   from './supplier-checkout-automation.service';
import { EscrowModule }       from '../escrow/escrow.module';
import { ShopifyModule }      from '../shopify/shopify.module';
import { AuditModule }        from '../audit/audit.module';
import { AlertingModule }     from '../alerting/alerting.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [forwardRef(() => EscrowModule), ShopifyModule, AuditModule, AlertingModule, NotificationsModule],
  providers: [SupplierFulfillmentService, SupplierCheckoutAutomationService],
  exports:   [SupplierFulfillmentService, SupplierCheckoutAutomationService],
})
export class SupplierFulfillmentModule {}
