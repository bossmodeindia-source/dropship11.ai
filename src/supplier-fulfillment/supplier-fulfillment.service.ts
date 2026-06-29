/**
 * SupplierFulfillmentService
 *
 * Manages the complete post-payment supplier fulfillment lifecycle:
 *
 *   Escrow created
 *   → FulfillmentTask generated (admin workspace queue)
 *   → Admin processes supplier order (manual or checkout-autofill)
 *   → Admin marks supplier paid → uploads proof
 *   → Tracking synced from supplier
 *   → Shopify order updated
 *   → Customer notified
 *
 * NEVER exposes supplier base costs or admin commission to users.
 */

import {
  Injectable, Logger, Inject, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, and, desc, isNull, lte, sql } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import { EscrowTransactionService } from '../escrow/escrow-transaction.service';
import { ShopifyService } from '../shopify/shopify.service';
import { AuditService } from '../audit/audit.service';
import { AlertingService } from '../alerting/alerting.service';
import { NotificationsService } from "../notifications/notifications.service";
import {
  supplierFulfillmentTasks,
  supplierCheckoutSessions,
  escrowTransactions,
} from '../escrow/escrow-schema';
import * as schema from '../common/database/schema';

export type FulfillmentStatus =
  | 'AWAITING_ADMIN'
  | 'CHECKOUT_OPENED'
  | 'SUPPLIER_ORDER_PLACED'
  | 'AWAITING_TRACKING'
  | 'TRACKING_RECEIVED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'FAILED'
  | 'REFUNDED';

export type SupportedSupplier = 'aliexpress' | 'cjdropshipping' | 'zendrop' | 'autods' | 'alibaba' | 'custom';

export interface CreateFulfillmentTaskInput {
  tenantId:           string;
  escrowId:           string;
  orderId:            string;
  supplier:           SupportedSupplier;
  supplierProductUrl: string;
  supplierVariantId?: string;
  customerName:       string;
  customerEmail:      string;
  shippingAddress:    Record<string, string>;
  quantity:           number;
  supplierPrice:      number;
  supplierShipping:   number;
}

export interface FulfillmentTaskAdminView {
  id:                 string;
  tenantId:           string;
  orderId:            string;
  escrowId:           string;
  supplier:           SupportedSupplier;
  supplierProductUrl: string | null;
  checkoutAutofill:   Record<string, unknown>;
  customerName:       string | null;
  customerEmail:      string | null;
  shippingAddress:    Record<string, string>;
  quantity:           number;
  supplierPrice:      number | null;
  supplierShipping:   number | null;
  supplierOrderId:    string | null;
  trackingNumber:     string | null;
  trackingCarrier:    string | null;
  trackingUrl:        string | null;
  status:             FulfillmentStatus;
  adminNotes:         string | null;
  createdAt:          Date;
  updatedAt:          Date;
}

@Injectable()
export class SupplierFulfillmentService {
  private readonly logger = new Logger(SupplierFulfillmentService.name);

  constructor(
    @Inject(DB_TOKEN)           private readonly db:     DrizzleDB,
    private readonly escrow:    EscrowTransactionService,
    private readonly shopify:   ShopifyService,
    private readonly audit:     AuditService,
    private readonly alerting:  AlertingService,
    private readonly notify:    NotificationsService,
  ) {}

  // ── Create fulfillment task when escrow is created ─────────────────────────

  async createTask(input: CreateFulfillmentTaskInput): Promise<string> {
    const autofill = this.buildCheckoutAutofill(input);

    const [row] = await this.db
      .insert(supplierFulfillmentTasks)
      .values({
        tenantId:           input.tenantId,
        escrowId:           input.escrowId,
        orderId:            input.orderId,
        supplier:           input.supplier,
        supplierProductUrl: input.supplierProductUrl,
        supplierVariantId:  input.supplierVariantId,
        checkoutAutofill:   autofill,
        customerName:       input.customerName,
        customerEmail:      input.customerEmail,
        shippingAddress:    input.shippingAddress,
        quantity:           input.quantity,
        supplierPrice:      String(input.supplierPrice),
        supplierShipping:   String(input.supplierShipping),
        status:             'AWAITING_ADMIN',
      })
      .returning({ id: supplierFulfillmentTasks.id });

    // Advance escrow state
    await this.escrow.advanceStatus(
      input.escrowId, 'AWAITING_SUPPLIER_PAYMENT', 'system',
      { fulfillmentTaskId: row.id },
    );

    this.logger.log(`Fulfillment task ${row.id} created for order ${input.orderId}`);
    return row.id;
  }

  // ── Admin: mark supplier paid + upload proof ───────────────────────────────

  async markSupplierPaid(
    fulfillmentId:  string,
    adminId:        string,
    paymentProofUrl?: string,
    supplierOrderId?: string,
  ): Promise<void> {
    const task = await this.getTask(fulfillmentId);
    if (!task) throw new NotFoundException(`Fulfillment task ${fulfillmentId} not found`);

    await this.db
      .update(supplierFulfillmentTasks)
      .set({
        status:         'SUPPLIER_ORDER_PLACED',
        markedPaidAt:   new Date(),
        processedByAdmin: adminId,
        processedAt:    new Date(),
        paymentProofUrl,
        supplierOrderId,
      })
      .where(eq(supplierFulfillmentTasks.id, fulfillmentId));

    await this.escrow.advanceStatus(task.escrowId, 'SUPPLIER_PAID', adminId);

    await this.audit.log({
      action:     'fulfillment.supplier_paid',
      resourceId: fulfillmentId,
      userId:     adminId,
      metadata:   { supplierOrderId },
    } as any);
  }

  // ── Admin: sync tracking number ────────────────────────────────────────────

  async syncTracking(
    fulfillmentId: string,
    adminId:       string,
    trackingNumber: string,
    trackingCarrier: string,
    trackingUrl?: string,
  ): Promise<void> {
    const task = await this.getTask(fulfillmentId);
    if (!task) throw new NotFoundException(`Fulfillment task ${fulfillmentId} not found`);

    await this.db
      .update(supplierFulfillmentTasks)
      .set({
        trackingNumber,
        trackingCarrier,
        trackingUrl,
        status:           'TRACKING_RECEIVED',
        trackingSyncedAt: new Date(),
      })
      .where(eq(supplierFulfillmentTasks.id, fulfillmentId));

    // Push tracking to Shopify (use tenant's connected store)
    try {
      await this.shopify.updateOrderTracking(
        task.orderId,
        trackingNumber,
        trackingCarrier,
        trackingUrl,
      );
    } catch (err) {
      this.logger.warn(`Shopify tracking sync failed for ${fulfillmentId}: ${err}`);
    }

    // Advance escrow
    await this.escrow.advanceStatus(task.escrowId, 'TRACKING_RECEIVED', adminId);

    // Notify user
    if (task.customerEmail) {
      await this.notify.notifyOrderFulfilled(
        task.customerEmail,
        task.orderId,
        trackingNumber,
      );
    }

    this.logger.log(`Tracking synced for fulfillment ${fulfillmentId}: ${trackingNumber}`);
  }

  // ── Admin list: pending fulfillments ──────────────────────────────────────

  async listPendingForAdmin(
    supplier?: SupportedSupplier,
    limit = 100,
  ): Promise<FulfillmentTaskAdminView[]> {
    const rows = await this.db
      .select()
      .from(supplierFulfillmentTasks)
      .where(
        supplier
          ? and(
              sql`${supplierFulfillmentTasks.status} IN ('AWAITING_ADMIN','CHECKOUT_OPENED','SUPPLIER_ORDER_PLACED')`,
              eq(supplierFulfillmentTasks.supplier, supplier),
            )
          : sql`${supplierFulfillmentTasks.status} IN ('AWAITING_ADMIN','CHECKOUT_OPENED','SUPPLIER_ORDER_PLACED')`,
      )
      .orderBy(desc(supplierFulfillmentTasks.createdAt))
      .limit(limit);

    return rows as unknown as FulfillmentTaskAdminView[];
  }

  // ── User view: fulfilment progress (no cost data) ─────────────────────────

  async getUserFulfillmentStatus(
    tenantId: string,
    orderId:  string,
  ): Promise<{ status: FulfillmentStatus; trackingNumber?: string; trackingUrl?: string } | null> {
    const rows = await this.db
      .select({
        status:        supplierFulfillmentTasks.status,
        trackingNumber: supplierFulfillmentTasks.trackingNumber,
        trackingUrl:    supplierFulfillmentTasks.trackingUrl,
      })
      .from(supplierFulfillmentTasks)
      .where(and(
        eq(supplierFulfillmentTasks.tenantId, tenantId),
        eq(supplierFulfillmentTasks.orderId, orderId),
      ))
      .limit(1);

    return rows[0] as any ?? null;
  }

  // ── Scheduled: retry stale tasks older than 30m ───────────────────────────

  @Cron(CronExpression.EVERY_30_MINUTES)
  async detectStaleTasksAlert(): Promise<void> {
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);

    const rows = await this.db
      .select({ id: supplierFulfillmentTasks.id, orderId: supplierFulfillmentTasks.orderId })
      .from(supplierFulfillmentTasks)
      .where(and(
        eq(supplierFulfillmentTasks.status, 'AWAITING_ADMIN'),
        lte(supplierFulfillmentTasks.createdAt, staleThreshold),
      ))
      .limit(50);

    if (rows.length > 0) {
      await this.alerting.sendWarn({
        title:   `${rows.length} supplier fulfillment tasks awaiting admin action`,
        message: `Orders pending: ${rows.map((r: any) => r.orderId).join(', ')}`,
      });
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async getTask(id: string) {
    const rows = await this.db
      .select()
      .from(supplierFulfillmentTasks)
      .where(eq(supplierFulfillmentTasks.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  private buildCheckoutAutofill(input: CreateFulfillmentTaskInput): Record<string, unknown> {
    return {
      productUrl:      input.supplierProductUrl,
      variantId:       input.supplierVariantId ?? null,
      quantity:        input.quantity,
      shippingName:    input.customerName,
      shippingEmail:   input.customerEmail,
      shippingAddress: input.shippingAddress,
      notes:           `AI Empire Platform Order — Tenant ${input.tenantId}`,
    };
  }
}
