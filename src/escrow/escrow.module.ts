/**
 * EscrowModule — V65 HARDENED
 *
 * V65 changes:
 *   + OutboxModule: EscrowTransactionService now uses OutboxService to publish
 *     ESCROW_CREATED, SUPPLIER_TASK_CREATED, ESCROW_STATUS_CHANGED, and
 *     PROFIT_DISTRIBUTED events atomically within DB transactions.
 *   + Idempotent escrow creation via ON CONFLICT (razorpay_payment_id) DO NOTHING
 *   + advanceStatus() wrapped in db.transaction() with audit + outbox in same tx
 */
import { Module, forwardRef } from '@nestjs/common';
import { EscrowTransactionService }           from './escrow-transaction.service';
import { RazorpayOrderWebhookController }  from './razorpay-order-webhook.controller';
import { AuditModule }                        from '../audit/audit.module';
import { AlertingModule }                     from '../alerting/alerting.module';
import { SupplierFulfillmentModule }          from '../supplier-fulfillment/supplier-fulfillment.module';
import { CommissionModule }                   from '../commission/commission.module';
import { OutboxModule }                       from '../common/outbox/outbox.module';

@Module({
  imports:     [AuditModule, AlertingModule, CommissionModule, forwardRef(() => SupplierFulfillmentModule), OutboxModule],
  providers:   [EscrowTransactionService],
  controllers: [RazorpayOrderWebhookController],
  exports:     [EscrowTransactionService],
})
export class EscrowModule {}
