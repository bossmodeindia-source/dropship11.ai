import { Module } from '@nestjs/common';
import { WalletService }      from './wallet.service';
import { WalletController }   from './wallet.controller';
import { OrderRefundService } from './order-refund.service';
import { AuditModule }        from '../audit/audit.module';
import { AlertingModule }     from '../alerting/alerting.module';
import { EscrowModule }       from '../escrow/escrow.module';
import { PaymentModule }      from '../payment/payment.module';

@Module({
  imports: [
    AuditModule,
    AlertingModule,
    EscrowModule,    // EscrowTransactionService
    PaymentModule,   // PaymentGatewayService
  ],
  providers:   [WalletService, OrderRefundService],
  controllers: [WalletController],
  exports:     [WalletService, OrderRefundService],
})
export class WalletModule {}
