/**
 * escrow-transaction.service.ts — V65 HARDENED
 *
 * Changes from V64:
 *
 *  FIX #1 — IDEMPOTENT ESCROW CREATION
 *    BEFORE: INSERT without duplicate check → duplicate escrow on Razorpay retry
 *    AFTER:  INSERT ... ON CONFLICT (razorpay_payment_id) DO NOTHING RETURNING
 *            Returns existing escrowId on duplicate → safe to call twice
 *
 *  FIX #2 — TRANSACTIONAL STATUS TRANSITION + OUTBOX
 *    BEFORE: update() and audit.log() were separate — crash between them = lost audit
 *    AFTER:  db.transaction() wraps status update + audit insert + outbox event
 *            All three succeed or all three roll back atomically
 *
 *  FIX #3 — SUPPLIER TASK CREATED IN SAME TRANSACTION
 *    BEFORE: createEscrow() returned, then caller separately created fulfillment task
 *            A crash between the two left escrow with no fulfillment task
 *    AFTER:  createEscrow() creates the outbox event for SUPPLIER_TASK_CREATED
 *            inside the same transaction → guaranteed delivery via outbox worker
 *
 *  FIX #4 — PROFIT DISTRIBUTION VIA OUTBOX
 *    BEFORE: No profit distribution step existed post-delivery
 *    AFTER:  advanceStatus() to DELIVERED emits PROFIT_DISTRIBUTED outbox event
 *            Downstream worker credits user wallet atomically
 */

import {
  Injectable, Logger, Inject,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DrizzleDB, DrizzleTx, DB_TOKEN }  from '../common/database/database.module';
import { AuditService }         from '../audit/audit.service';
import { AlertingService }      from '../alerting/alerting.service';
import { OutboxService }        from '../common/outbox/outbox.service';
import { DomainEventType }      from '../common/events/domain-events';
import {
  escrowTransactions,
  supplierFulfillmentTasks,
} from './escrow-schema';

export type EscrowStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_VERIFIED'
  | 'ESCROW_CREATED'
  | 'AWAITING_SUPPLIER_PAYMENT'
  | 'SUPPLIER_PAYMENT_PROCESSING'
  | 'SUPPLIER_PAID'
  | 'SUPPLIER_FULFILLING'
  | 'TRACKING_RECEIVED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'FAILED'
  | 'REFUNDED';

export interface CreateEscrowInput {
  tenantId:             string;
  orderId:              string;
  razorpayPaymentId:    string;
  razorpayOrderId:      string;
  customerPaidAmount:   number;
  razorpayFee:          number;
  supplierProductCost:  number;
  supplierShippingCost: number;
  taxAmount:            number;
  adminCommission:      number;
  currency:             string;
}

export interface EscrowPublicView {
  id:            string;
  orderId:       string;
  userProfit:    number;
  currency:      string;
  status:        EscrowStatus;
  deliveredAt:   Date | null;
}

export interface EscrowAdminView {
  id:                   string;
  tenantId:             string;
  orderId:              string;
  razorpayPaymentId:    string | null;
  customerPaidAmount:   number;
  razorpayFee:          number;
  supplierProductCost:  number;
  supplierShippingCost: number;
  taxAmount:            number;
  adminCommission:      number;
  userProfit:           number;
  currency:             string;
  status:               EscrowStatus;
  paymentVerifiedAt:    Date | null;
  supplierPaidAt:       Date | null;
  deliveredAt:          Date | null;
  createdAt:            Date;
}

const RAZORPAY_RATE      = 0.02;
const RAZORPAY_FIXED_FEE = 3.0;

@Injectable()
export class EscrowTransactionService {
  private readonly logger = new Logger(EscrowTransactionService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly audit:    AuditService,
    private readonly alerting: AlertingService,
    private readonly outbox:   OutboxService,  // ← ADDED: outbox for reliable events
  ) {}

  // ── Static fee calculator ─────────────────────────────────────────────────

  static calculateFees(grossAmount: number): {
    razorpayFee: number;
    netAfterGateway: number;
  } {
    const razorpayFee = +(grossAmount * RAZORPAY_RATE + RAZORPAY_FIXED_FEE).toFixed(2);
    return { razorpayFee, netAfterGateway: +(grossAmount - razorpayFee).toFixed(2) };
  }

  // ── Create escrow — IDEMPOTENT ────────────────────────────────────────────
  //
  // FIX #1: Uses ON CONFLICT DO NOTHING on razorpay_payment_id.
  // If a webhook fires twice, the second call returns the existing escrowId.
  // The outbox event is only emitted once (not on duplicate).

  async createEscrow(input: CreateEscrowInput): Promise<{ escrowId: string; created: boolean }> {
    const userProfit = +(
      input.customerPaidAmount
      - input.razorpayFee
      - input.supplierProductCost
      - input.supplierShippingCost
      - input.taxAmount
      - input.adminCommission
    ).toFixed(2);

    if (userProfit < 0) {
      this.logger.warn(
        `Escrow would yield negative user profit for order ${input.orderId}: ₹${userProfit}`,
      );
    }

    // FIX #1: Wrap creation + audit + outbox in a single transaction
    const result = await this.db.transaction(async (tx) => {
      // Idempotent insert: conflict on razorpay_payment_id
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO escrow_transactions (
          id, tenant_id, order_id, razorpay_payment_id, razorpay_order_id,
          customer_paid_amount, razorpay_fee, supplier_product_cost,
          supplier_shipping_cost, tax_amount, admin_commission,
          currency, status, payment_verified_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(),
          ${input.tenantId}, ${input.orderId}, ${input.razorpayPaymentId},
          ${input.razorpayOrderId},
          ${String(input.customerPaidAmount)}, ${String(input.razorpayFee)},
          ${String(input.supplierProductCost)}, ${String(input.supplierShippingCost)},
          ${String(input.taxAmount)}, ${String(input.adminCommission)},
          ${input.currency}, 'ESCROW_CREATED', NOW(), NOW(), NOW()
        )
        ON CONFLICT (razorpay_payment_id) DO NOTHING
        RETURNING id
      `);

      if (!rows.rows.length) {
        // Duplicate — fetch existing
        const existing = await tx.execute<{ id: string }>(sql`
          SELECT id FROM escrow_transactions
          WHERE razorpay_payment_id = ${input.razorpayPaymentId}
          LIMIT 1
        `);
        return { escrowId: existing.rows[0].id, created: false };
      }

      const escrowId = rows.rows[0].id;

      // Audit log in same transaction
      await tx.execute(sql`
        INSERT INTO audit_logs (id, action, resource_id, tenant_id, metadata, created_at)
        VALUES (
          gen_random_uuid(),
          'escrow.created',
          ${escrowId},
          ${input.tenantId},
          ${JSON.stringify({ orderId: input.orderId, status: 'ESCROW_CREATED' })}::jsonb,
          NOW()
        )
      `);

      // Outbox event in same transaction — triggers supplier task creation reliably
      await this.outbox.publishInTx(tx as DrizzleTx, DomainEventType.ESCROW_CREATED, input.tenantId, {
        escrowId,
        orderId:            input.orderId,
        razorpayPaymentId:  input.razorpayPaymentId,
        customerPaidAmount: input.customerPaidAmount,
        userProfit,
        currency:           input.currency,
      });

      return { escrowId, created: true };
    });

    if (result.created) {
      this.logger.log(
        `Escrow ${result.escrowId} created for order ${input.orderId} | profit: ₹${userProfit}`,
      );
    } else {
      this.logger.debug(
        `Duplicate escrow creation ignored for payment ${input.razorpayPaymentId} — returning existing ${result.escrowId}`,
      );
    }

    return result;
  }

  // ── Advance status — TRANSACTIONAL ───────────────────────────────────────
  //
  // FIX #2: status update + audit log + outbox event are all in one transaction.
  // If any step fails, none of the three are committed.

  async advanceStatus(
    escrowId:  string,
    toStatus:  EscrowStatus,
    adminId:   string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const escrow = await this.getAdminView(escrowId);
    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);

    const allowed = this.allowedTransitions(escrow.status);
    if (!allowed.includes(toStatus)) {
      throw new BadRequestException(
        `Cannot transition escrow from ${escrow.status} → ${toStatus}. Allowed: ${allowed.join(', ')}`,
      );
    }

    const patch: Record<string, unknown> = {
      status:    toStatus,
      updatedAt: new Date(),
      ...(metadata ?? {}),
    };
    if (toStatus === 'SUPPLIER_PAID')  patch.supplierPaidAt = new Date();
    if (toStatus === 'DELIVERED')      patch.deliveredAt    = new Date();
    if (toStatus === 'REFUNDED')       patch.refundedAt     = new Date();

    // FIX #2: Atomic transaction for status + audit + outbox
    await this.db.transaction(async (tx) => {
      // 1. Update status
      await tx
        .update(escrowTransactions)
        .set(patch as any)
        .where(eq(escrowTransactions.id, escrowId));

      // 2. Audit log (same tx — no lost audit)
      await tx.execute(sql`
        INSERT INTO audit_logs (id, action, resource_id, user_id, tenant_id, metadata, created_at)
        VALUES (
          gen_random_uuid(), 'escrow.status_advanced',
          ${escrowId}, ${adminId}, ${escrow.tenantId},
          ${JSON.stringify({ from: escrow.status, to: toStatus })}::jsonb,
          NOW()
        )
      `);

      // 3. Outbox event for downstream processing (same tx — guaranteed delivery)
      const eventType = this.statusToEventType(toStatus);
      if (eventType) {
        await this.outbox.publishInTx(tx as DrizzleTx, eventType, escrow.tenantId, {
          escrowId,
          orderId:   escrow.orderId,
          fromStatus: escrow.status,
          toStatus,
          changedBy:  adminId,
          ...(metadata ?? {}),
        });
      }

      // FIX #3: Profit distribution event on DELIVERED
      if (toStatus === 'DELIVERED') {
        await this.outbox.publishInTx(tx as DrizzleTx, DomainEventType.PROFIT_DISTRIBUTED, escrow.tenantId, {
          escrowId,
          orderId:    escrow.orderId,
          userProfit: escrow.userProfit,
          currency:   escrow.currency,
        });
      }
    });

    if (toStatus === 'FAILED') {
      // Alert fires AFTER transaction commits — non-blocking
      await this.alerting.sendCritical({
        title:   `Escrow ${escrowId} marked FAILED`,
        message: `Order ${escrow.orderId} escrow failed. Manual review required.`,
      });
    }

    this.logger.log(
      `Escrow ${escrowId}: ${escrow.status} → ${toStatus} (by ${adminId})`,
    );
  }

  // ── Map status → outbox event type ───────────────────────────────────────

  private statusToEventType(status: EscrowStatus): DomainEventType | null {
    const map: Partial<Record<EscrowStatus, DomainEventType>> = {
      ESCROW_CREATED:   DomainEventType.ESCROW_CREATED,
      SUPPLIER_PAID:    DomainEventType.SUPPLIER_PAID,
      TRACKING_RECEIVED: DomainEventType.TRACKING_RECEIVED,
      SHIPPED:          DomainEventType.ORDER_SHIPPED,
      DELIVERED:        DomainEventType.ORDER_DELIVERED,
    };
    return map[status] ?? null;
  }

  // ── Views (unchanged from V64) ────────────────────────────────────────────

  async getUserView(tenantId: string, orderId: string): Promise<EscrowPublicView | null> {
    const rows = await this.db
      .select({
        id:          escrowTransactions.id,
        orderId:     escrowTransactions.orderId,
        currency:    escrowTransactions.currency,
        status:      escrowTransactions.status,
        deliveredAt: escrowTransactions.deliveredAt,
        customerPaid:   escrowTransactions.customerPaidAmount,
        fee:            escrowTransactions.razorpayFee,
        prodCost:       escrowTransactions.supplierProductCost,
        shipCost:       escrowTransactions.supplierShippingCost,
        tax:            escrowTransactions.taxAmount,
        commission:     escrowTransactions.adminCommission,
      })
      .from(escrowTransactions)
      .where(and(
        eq(escrowTransactions.tenantId, tenantId),
        eq(escrowTransactions.orderId, orderId),
      ))
      .limit(1);

    if (!rows.length) return null;
    const r = rows[0];

    return {
      id:          r.id,
      orderId:     r.orderId,
      userProfit:  +( +r.customerPaid - +r.fee - +r.prodCost - +r.shipCost - +r.tax - +r.commission ).toFixed(2),
      currency:    r.currency,
      status:      r.status as EscrowStatus,
      deliveredAt: r.deliveredAt,
    };
  }

  async getAdminView(escrowId: string): Promise<EscrowAdminView | null> {
    const rows = await this.db
      .select()
      .from(escrowTransactions)
      .where(eq(escrowTransactions.id, escrowId))
      .limit(1);

    if (!rows.length) return null;
    const r = rows[0];

    const userProfit = +(
      +r.customerPaidAmount - +r.razorpayFee - +r.supplierProductCost
      - +r.supplierShippingCost - +r.taxAmount - +r.adminCommission
    ).toFixed(2);

    return { ...r, userProfit } as unknown as EscrowAdminView;
  }

  async listPendingSupplierPayments(): Promise<EscrowAdminView[]> {
    const rows = await this.db
      .select()
      .from(escrowTransactions)
      .where(eq(escrowTransactions.status, 'AWAITING_SUPPLIER_PAYMENT'))
      .orderBy(desc(escrowTransactions.createdAt))
      .limit(200);

    return rows.map((r: any) => ({
      ...r,
      userProfit: +( +r.customerPaidAmount - +r.razorpayFee - +r.supplierProductCost
        - +r.supplierShippingCost - +r.taxAmount - +r.adminCommission ).toFixed(2),
    })) as unknown as EscrowAdminView[];
  }

  async getAdminFinancialSummary(fromDate: Date, toDate: Date) {
    const rows = await this.db
      .select({
        gross:      sql<number>`SUM(${escrowTransactions.customerPaidAmount})`,
        commission: sql<number>`SUM(${escrowTransactions.adminCommission})`,
        rpFee:      sql<number>`SUM(${escrowTransactions.razorpayFee})`,
        prodCost:   sql<number>`SUM(${escrowTransactions.supplierProductCost})`,
        shipCost:   sql<number>`SUM(${escrowTransactions.supplierShippingCost})`,
        tax:        sql<number>`SUM(${escrowTransactions.taxAmount})`,
        cnt:        sql<number>`COUNT(*)`,
      })
      .from(escrowTransactions)
      .where(
        sql`${escrowTransactions.createdAt} BETWEEN ${fromDate} AND ${toDate}
            AND ${escrowTransactions.status} NOT IN ('FAILED','REFUNDED')`,
      );

    const r = rows[0];
    return {
      totalGrossRevenue:    +r.gross || 0,
      totalAdminCommission: +r.commission || 0,
      totalUserProfit:      +(+r.gross - +r.rpFee - +r.prodCost - +r.shipCost - +r.tax - +r.commission).toFixed(2),
      totalSupplierPayable: +(+r.prodCost + +r.shipCost).toFixed(2),
      totalRazorpayFees:    +r.rpFee || 0,
      orderCount:           +r.cnt || 0,
    };
  }

  private allowedTransitions(current: EscrowStatus): EscrowStatus[] {
    const map: Record<EscrowStatus, EscrowStatus[]> = {
      PENDING_PAYMENT:             ['PAYMENT_VERIFIED', 'FAILED'],
      PAYMENT_VERIFIED:            ['ESCROW_CREATED', 'FAILED'],
      ESCROW_CREATED:              ['AWAITING_SUPPLIER_PAYMENT', 'FAILED'],
      AWAITING_SUPPLIER_PAYMENT:   ['SUPPLIER_PAYMENT_PROCESSING', 'FAILED'],
      SUPPLIER_PAYMENT_PROCESSING: ['SUPPLIER_PAID', 'FAILED'],
      SUPPLIER_PAID:               ['SUPPLIER_FULFILLING'],
      SUPPLIER_FULFILLING:         ['TRACKING_RECEIVED', 'FAILED'],
      TRACKING_RECEIVED:           ['SHIPPED'],
      SHIPPED:                     ['DELIVERED', 'FAILED'],
      DELIVERED:                   ['REFUNDED'],
      FAILED:                      ['REFUNDED'],
      REFUNDED:                    [],
    };
    return map[current] ?? [];
  }
}
