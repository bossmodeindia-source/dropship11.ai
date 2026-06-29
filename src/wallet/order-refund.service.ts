/**
 * OrderRefundService
 *
 * Orchestrates the full return/refund flow:
 *
 *   Shopify return webhook OR admin triggers refund
 *     → Lookup escrow for original payment details
 *     → Issue gateway refund (Razorpay/Stripe) to original payment method
 *     → Credit user platform wallet with refund amount
 *     → Advance escrow status to REFUNDED
 *     → Send Telegram/email notification to user
 *
 * Called from:
 *   - ShopifyReturnWebhookController  (automatic, on return/refund Shopify events)
 *   - AdminFulfillmentController      (manual admin trigger)
 */

import {
  Injectable, Logger, Inject,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { escrowTransactions } from '../escrow/escrow-schema';
import { EscrowTransactionService } from '../escrow/escrow-transaction.service';
import { WalletService } from '../wallet/wallet.service';
import { PaymentGatewayService } from '../payment/payment-gateway.service';
import { AlertingService } from '../alerting/alerting.service';
import { AuditService } from '../audit/audit.service';

export interface RefundOrderOptions {
  /** Platform internal order ID */
  orderId:       string;
  /** Reason as shown to customer */
  reason:        string;
  /** Optional: partial refund amount in INR. Defaults to full customer paid amount. */
  partialAmount?: number;
  /** Admin user performing refund (if manual) */
  adminId?:      string;
  /** Shopify refund ID (if triggered by webhook) */
  shopifyRefundId?: string;
}

export interface RefundOrderResult {
  orderId:         string;
  escrowId:        string;
  refundAmount:    number;
  gatewayRefundId: string;
  walletTxId:      string;
  walletBalance:   number;
}

@Injectable()
export class OrderRefundService {
  private readonly logger = new Logger(OrderRefundService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly escrow:   EscrowTransactionService,
    private readonly wallet:   WalletService,
    private readonly gateway:  PaymentGatewayService,
    private readonly alerting: AlertingService,
    private readonly audit:    AuditService,
  ) {}

  // ── Main refund flow ───────────────────────────────────────────────────────

  async refundOrder(opts: RefundOrderOptions): Promise<RefundOrderResult> {
    this.logger.log(`Starting refund for order ${opts.orderId} | reason: ${opts.reason}`);

    // 1. Fetch order
    const orders = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, opts.orderId))
      .limit(1);

    if (!orders.length) {
      throw new NotFoundException(`Order ${opts.orderId} not found`);
    }
    const order = orders[0];

    // 2. Fetch escrow record
    const escrows = await this.db
      .select()
      .from(escrowTransactions)
      .where(eq(escrowTransactions.orderId, opts.orderId))
      .limit(1);

    if (!escrows.length) {
      throw new NotFoundException(`Escrow for order ${opts.orderId} not found`);
    }
    const escrowRow = escrows[0];

    // Guard: don't double-refund
    if (escrowRow.status === 'REFUNDED') {
      throw new BadRequestException(`Order ${opts.orderId} has already been refunded`);
    }

    // Guard: only refund paid orders
    const refundableStatuses = [
      'ESCROW_CREATED', 'AWAITING_SUPPLIER_PAYMENT', 'SUPPLIER_PAID',
      'SUPPLIER_FULFILLING', 'TRACKING_RECEIVED', 'SHIPPED', 'DELIVERED', 'FAILED',
    ];
    if (!refundableStatuses.includes(escrowRow.status)) {
      throw new BadRequestException(
        `Cannot refund order in status: ${escrowRow.status}`,
      );
    }

    const customerPaidAmount = +escrowRow.customerPaidAmount;
    const refundAmount = opts.partialAmount ?? customerPaidAmount;

    if (refundAmount > customerPaidAmount) {
      throw new BadRequestException(
        `Refund amount ₹${refundAmount} exceeds paid amount ₹${customerPaidAmount}`,
      );
    }

    // 3. Determine gateway provider + payment ID
    const provider = escrowRow.razorpayPaymentId ? 'razorpay' : 'stripe';
    const gatewayPaymentId = escrowRow.razorpayPaymentId ?? '';

    if (!gatewayPaymentId) {
      throw new BadRequestException(`No gateway payment ID found for order ${opts.orderId}`);
    }

    // 4. Issue gateway refund (to original payment method)
    let gatewayRefundId: string;
    try {
      const refundResult = await this.gateway.issueRefund({
        provider,
        gatewayPaymentId,
        amount: PaymentGatewayService.toSmallestUnit(refundAmount, escrowRow.currency),
        reason: opts.reason,
        notes:  {
          order_id:     opts.orderId,
          shopify_refund_id: opts.shopifyRefundId ?? '',
        },
      });

      gatewayRefundId = refundResult.refundId;
      this.logger.log(`Gateway refund issued | refundId=${gatewayRefundId} | ₹${refundAmount}`);
    } catch (err) {
      this.logger.error(`Gateway refund failed for order ${opts.orderId}: ${err}`);
      throw err;
    }

    // 5. Credit user's platform wallet
    const walletTx = await this.wallet.credit(order.userId, {
      amount:           refundAmount,
      type:             'REFUND',
      description:      `Refund for order #${order.platformOrderId ?? opts.orderId} — ${opts.reason}`,
      orderId:          opts.orderId,
      escrowId:         escrowRow.id,
      gatewayPaymentId: gatewayPaymentId,
      gatewayProvider:  provider,
      ...(provider === 'razorpay'
        ? { razorpayRefundId: gatewayRefundId }
        : { stripeRefundId:   gatewayRefundId }
      ),
      metadata: {
        shopifyRefundId: opts.shopifyRefundId,
        adminId:         opts.adminId,
        partialRefund:   !!opts.partialAmount,
      },
    });

    // 6. Advance escrow to REFUNDED
    await this.escrow.advanceStatus(
      escrowRow.id,
      'REFUNDED',
      opts.adminId ?? 'system',
      {
        refundReason: opts.reason,
        refundedAt:   new Date(),
        gatewayRefundId,
        shopifyRefundId: opts.shopifyRefundId,
      },
    );

    // 7. Update order status
    await this.db
      .update(schema.orders)
      .set({ status: 'refunded', updatedAt: new Date() } as any)
      .where(eq(schema.orders.id, opts.orderId));

    // 8. Alert user
    const newBalance = await this.wallet.getBalance(order.userId);
    await this.alerting.sendInfo({
      title:   `✅ Refund processed for order #${order.platformOrderId}`,
      message: `₹${refundAmount} refunded | Wallet balance: ₹${newBalance.balance} | Order: ${opts.orderId}`,
    });

    await this.audit.log({
      action:     'order.refunded',
      resourceId: opts.orderId,
      userId:     opts.adminId ?? order.userId,
      metadata:   {
        refundAmount,
        gatewayRefundId,
        walletTxId: walletTx.id,
        reason:     opts.reason,
      },
    } as any);

    this.logger.log(
      `✅ Refund complete | order=${opts.orderId} | ₹${refundAmount} | wallet_tx=${walletTx.id} | wallet_balance=₹${newBalance.balance}`,
    );

    return {
      orderId:         opts.orderId,
      escrowId:        escrowRow.id,
      refundAmount,
      gatewayRefundId,
      walletTxId:      walletTx.id,
      walletBalance:   newBalance.balance,
    };
  }
}
