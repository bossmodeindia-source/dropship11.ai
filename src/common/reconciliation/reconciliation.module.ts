/**
 * ReconciliationModule — V65
 *
 * Runs payment reconciliation on a 30-minute schedule:
 *   1. Orphaned payments (Razorpay captured but no escrow)
 *   2. Stuck escrows (AWAITING_SUPPLIER_PAYMENT > 24h)
 *   3. Missing supplier tasks (ESCROW_CREATED but no task)
 *   4. Delivered without profit (DELIVERED but wallet not credited)
 *
 * Add to AppModule imports after RecoveryModule:
 *   ReconciliationModule,
 */
import { Module }          from '@nestjs/common';
import { DatabaseModule }  from '../database/database.module';
import { AlertingModule }  from '../../alerting/alerting.module';
import { OutboxModule }    from '../outbox/outbox.module';
import { PaymentReconciliationService } from './payment-reconciliation.service';

@Module({
  imports:   [DatabaseModule, AlertingModule, OutboxModule],
  providers: [PaymentReconciliationService],
  exports:   [PaymentReconciliationService],
})
export class ReconciliationModule {}
