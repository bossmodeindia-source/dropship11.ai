/**
 * SupplierPaymentService
 *
 * Tracks and enforces supplier payments as a precondition to order fulfillment.
 *
 * FULFILLMENT SAFETY RULE:
 *   if supplier_payment.status !== 'paid':
 *     block_fulfillment()
 *
 * This service does NOT move money. It tracks the payment state.
 * Users pay suppliers through the platform workflow:
 *   1. Platform shows user the supplier amount (cost + commission applied)
 *   2. User confirms payment (via bank transfer or supported gateway)
 *   3. Admin marks supplier as paid
 *   4. Order lifecycle advances: supplier_paid → processing → fulfilled
 *
 * PRIVACY:
 *   Users see only: amount_to_pay (= supplier_cost + commission)
 *   Users NEVER see: raw supplier_base_price or commission_amount
 */

import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import * as ext from '../commerce/schema-extensions';
import { CommissionService } from '../commission/commission.service';
import { AuditService } from '../audit/audit.service';
import { AlertingService } from '../alerting/alerting.service';

export interface SupplierPaymentRecord {
  id:               string;
  orderId:          string;
  tenantId:         string;
  userId:           string;
  amountToPay:      number; // supplier_cost + commission — what user sees
  supplierAmount:   number; // actual supplier cut — admin only
  commissionAmount: number; // platform cut — admin only
  currency:         string;
  status:           'pending' | 'initiated' | 'paid' | 'failed';
  paidAt:           Date | null;
  notes:            string | null;
}

export interface SupplierPaymentUserView {
  id:          string;
  orderId:     string;
  amountToPay: number; // user-safe: includes commission
  currency:    string;
  status:      string;
  paidAt:      Date | null;
}

@Injectable()
export class SupplierPaymentService {
  private readonly logger = new Logger(SupplierPaymentService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly commission: CommissionService,
    private readonly audit: AuditService,
    private readonly alerting: AlertingService,
  ) {}

  // ── Create supplier payment record when order is synced ──────────────────

  async createForOrder(input: {
    orderId:          string;
    tenantId:         string;
    userId:           string;
    rawSupplierPrice: number;
    currency:         string;
    productCategory?: string;
  }): Promise<SupplierPaymentUserView> {
    // Compute price floor — commission is applied here
    const floor = await this.commission.computePriceFloor(
      input.rawSupplierPrice,
      input.currency,
      input.productCategory,
    );

    const [created] = await this.db
      .insert(ext.supplierPayments)
      .values({
        orderId:          input.orderId,
        tenantId:         input.tenantId,
        userId:           input.userId,
        amount:           String(floor.minimumAllowedPrice), // what user pays
        amountDue:         String(floor.supplierPrice),
        currency:          input.currency,
        notes:             JSON.stringify({ supplierBasePrice: floor.supplierPrice, commissionAmount: floor.commissionAmount }),
        status:            'pending',
      })
      .returning();

    this.logger.log(
      `Supplier payment created: orderId=${input.orderId} amount=₹${floor.minimumAllowedPrice} ` +
      `[internal: supplier=₹${floor.supplierPrice} commission=₹${floor.commissionAmount}]`,
    );

    return this.toUserView(created);
  }

  // ── User: initiate payment (UX signal — admin confirms) ──────────────────

  async initiatePayment(
    paymentId: string,
    userId: string,
    tenantId: string,
  ): Promise<SupplierPaymentUserView> {
    const payment = await this.findAndValidateTenant(paymentId, tenantId);

    if (payment.status !== 'pending') {
      throw new BadRequestException(
        `Cannot initiate payment with status '${payment.status}'`,
      );
    }

    const [updated] = await this.db
      .update(ext.supplierPayments)
      .set({ status: 'initiated', updatedAt: new Date() })
      .where(eq(ext.supplierPayments.id, paymentId))
      .returning();

    await this.audit.log({
      tenantId,
      actorId:    userId,
      action:     'SUPPLIER_PAYMENT_INITIATED',
      resource:   'supplier_payments',
      resourceId: paymentId,
      severity:   'info',
      details:    { orderId: payment.orderId, amount: payment.amount },
    });

    return this.toUserView(updated);
  }

  // ── Admin: mark payment as received ──────────────────────────────────────

  async adminMarkPaid(
    paymentId: string,
    adminId: string,
    notes?: string,
  ): Promise<SupplierPaymentRecord> {
    const [payment] = await this.db
      .select()
      .from(ext.supplierPayments)
      .where(eq(ext.supplierPayments.id, paymentId))
      .limit(1);

    if (!payment) throw new NotFoundException(`Supplier payment ${paymentId} not found`);

    if (payment.status === 'paid') {
      throw new BadRequestException('Payment already marked as paid');
    }

    const [updated] = await this.db
      .update(ext.supplierPayments)
      .set({
        status:    'paid',
        paidAt:    new Date(),
        notes,
        updatedAt: new Date(),
      })
      .where(eq(ext.supplierPayments.id, paymentId))
      .returning();

    // Update order status → supplier_paid
    await this.db
      .update(schema.orders)
      .set({ status: 'supplier_submitted', updatedAt: new Date() })
      .where(eq(schema.orders.id, payment.orderId));

    await this.audit.log({
      tenantId:   payment.tenantId,
      actorId:    adminId,
      action:     'SUPPLIER_PAYMENT_CONFIRMED',
      resource:   'supplier_payments',
      resourceId: paymentId,
      severity:   'info',
      details: {
        orderId:          payment.orderId,
        amount:           payment.amount,
        supplierBasePrice: (() => { try { return JSON.parse(payment.notes ?? '{}').supplierBasePrice; } catch { return undefined; } })(),
        commissionAmount:  (() => { try { return JSON.parse(payment.notes ?? '{}').commissionAmount; } catch { return undefined; } })(),
      },
    });

    return this.toFullRecord(updated);
  }

  // ── Safety: check if supplier is paid before fulfillment ─────────────────

  /**
   * Called by the fulfillment service before shipping.
   * Throws ForbiddenException if supplier has not been paid.
   */
  async assertSupplierPaid(orderId: string, tenantId: string): Promise<void> {
    const [payment] = await this.db
      .select({ status: ext.supplierPayments.status })
      .from(ext.supplierPayments)
      .where(
        and(
          eq(ext.supplierPayments.orderId,  orderId),
          eq(ext.supplierPayments.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!payment || payment.status !== 'paid') {
      this.logger.warn(
        `FULFILLMENT BLOCKED: orderId=${orderId} supplier not paid (status=${payment?.status ?? 'missing'})`,
      );

      await this.alerting.sendCritical({
        title:   '🚫 Fulfillment Blocked — Supplier Unpaid',
        message: `Attempt to fulfill order ${orderId} (tenant: ${tenantId}) blocked because supplier payment is not confirmed.`,
      });

      throw new ForbiddenException(
        `Cannot fulfill order ${orderId}: supplier payment has not been confirmed. ` +
        `Complete supplier payment before attempting fulfillment.`,
      );
    }
  }

  // ── User: list payments for their orders ──────────────────────────────────

  async getUserPayments(
    userId: string,
    tenantId: string,
  ): Promise<SupplierPaymentUserView[]> {
    const rows = await this.db
      .select({
        id:       ext.supplierPayments.id,
        orderId:  ext.supplierPayments.orderId,
        amount:   ext.supplierPayments.amount,
        currency: ext.supplierPayments.currency,
        status:   ext.supplierPayments.status,
        paidAt:   ext.supplierPayments.paidAt,
        // NEVER select supplierBasePrice or commissionAmount
      })
      .from(ext.supplierPayments)
      .where(
        and(
          eq(ext.supplierPayments.userId,   userId),
          eq(ext.supplierPayments.tenantId, tenantId),
        ),
      );

    return rows.map(this.toUserView.bind(this));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async findAndValidateTenant(paymentId: string, tenantId: string) {
    const [payment] = await this.db
      .select()
      .from(ext.supplierPayments)
      .where(
        and(
          eq(ext.supplierPayments.id,       paymentId),
          eq(ext.supplierPayments.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!payment) {
      throw new NotFoundException(`Supplier payment ${paymentId} not found`);
    }
    return payment;
  }

  private toUserView(row: any): SupplierPaymentUserView {
    return {
      id:          row.id,
      orderId:     row.orderId,
      amountToPay: parseFloat(row.amount), // includes commission — safe to show
      currency:    row.currency,
      status:      row.status,
      paidAt:      row.paidAt,
    };
  }

  private toFullRecord(row: any): SupplierPaymentRecord {
    return {
      id:               row.id,
      orderId:          row.orderId,
      tenantId:         row.tenantId,
      userId:           row.userId,
      amountToPay:      parseFloat(row.amount),
      supplierAmount:   parseFloat(row.supplierBasePrice ?? '0'),
      commissionAmount: parseFloat(row.commissionAmount  ?? '0'),
      currency:         row.currency,
      status:           row.status,
      paidAt:           row.paidAt,
      notes:            row.notes,
    };
  }

/** V60 webhook alias — dispatches supplier fulfillment for a Shopify order */
  async dispatchFulfillment(orderId: string, payload: Record<string, unknown>): Promise<void> {
    this.logger.log(`dispatchFulfillment orderId=${orderId}`);
    await this.createForOrder({ orderId, ...payload } as Parameters<typeof this.createForOrder>[0]);
  }
}
