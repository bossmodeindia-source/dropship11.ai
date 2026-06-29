/**
 * payment-reconciliation.service.ts
 *
 * Scheduled reconciliation job that detects and alerts on:
 *
 *  1. ORPHANED PAYMENTS — Razorpay payment captured but no escrow created
 *     Happens when: webhook fires but app crashes between payment verification
 *     and escrow creation.
 *     Resolution: Re-emit ORDER_PAID event → escrow creation retried via outbox.
 *
 *  2. STUCK ESCROWS — Escrow in AWAITING_SUPPLIER_PAYMENT for > 24h
 *     Happens when: Admin dashboard was not checked / task queue backed up.
 *     Resolution: Alert admin + escalation after 48h.
 *
 *  3. MISSING SUPPLIER TASKS — Escrow in ESCROW_CREATED but no fulfillment task
 *     Happens when: outbox worker failed to deliver SUPPLIER_TASK_CREATED event.
 *     Resolution: Replay the outbox event.
 *
 *  4. DELIVERED WITHOUT PROFIT — Order DELIVERED but user wallet not credited
 *     Happens when: PROFIT_DISTRIBUTED outbox event failed permanently.
 *     Resolution: Re-emit PROFIT_DISTRIBUTED.
 *
 * Schedule: runs every 30 minutes. Idempotent — safe to run multiple times.
 */

import { Injectable, Logger, Inject }  from '@nestjs/common';
import { Cron, CronExpression }        from '@nestjs/schedule';
import { DrizzleDB, DB_TOKEN }         from '../database/database.module';
import { AlertingService }             from '../../alerting/alerting.service';
import { OutboxService }               from '../outbox/outbox.service';
import { DomainEventType }             from '../events/domain-events';
import { sql }                         from 'drizzle-orm';

interface ReconciliationResult {
  orphanedPayments:       number;
  stuckEscrows:           number;
  missingSupplierTasks:   number;
  deliveredWithoutProfit: number;
  totalAlertsRaised:      number;
  ranAt:                  Date;
}

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private running = false;

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly alerting: AlertingService,
    private readonly outbox:   OutboxService,
  ) {}

  @Cron('*/30 * * * *') // every 30 minutes
  async reconcile(): Promise<ReconciliationResult | null> {
    if (this.running) {
      this.logger.warn('Reconciliation already running — skipping this cycle');
      return null;
    }

    this.running = true;
    const result: ReconciliationResult = {
      orphanedPayments:       0,
      stuckEscrows:           0,
      missingSupplierTasks:   0,
      deliveredWithoutProfit: 0,
      totalAlertsRaised:      0,
      ranAt:                  new Date(),
    };

    try {
      await Promise.all([
        this.detectOrphanedPayments(result),
        this.detectStuckEscrows(result),
        this.detectMissingSupplierTasks(result),
        this.detectDeliveredWithoutProfit(result),
      ]);

      this.logger.log(
        `Reconciliation complete: ${JSON.stringify(result)}`,
      );

      if (result.totalAlertsRaised > 0) {
        await this.alerting.sendCritical({
          title:   `Payment Reconciliation: ${result.totalAlertsRaised} issues found`,
          message: JSON.stringify(result, null, 2),
        });
      }
    } catch (err) {
      this.logger.error(`Reconciliation failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }

    return result;
  }

  // ── 1. Orphaned payments ──────────────────────────────────────────────────

  private async detectOrphanedPayments(result: ReconciliationResult): Promise<void> {
    // Find razorpay captures (from subscription or order payment events) with no escrow
    // We detect via outbox_events: PAYMENT_CAPTURED but no corresponding ESCROW_CREATED
    const orphaned = await this.db.execute<{ payment_id: string; tenant_id: string; payload: any }>(sql`
      SELECT o.id, o.tenant_id, o.payload
      FROM outbox_events o
      WHERE o.event_type = 'PAYMENT_CAPTURED'
        AND o.status = 'SENT'
        AND o.sent_at < NOW() - INTERVAL '30 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM escrow_transactions e
          WHERE e.razorpay_payment_id = o.payload->>'razorpayPaymentId'
        )
      LIMIT 20
    `);

    result.orphanedPayments = orphaned.rows.length;

    for (const row of orphaned.rows) {
      this.logger.error(
        `ORPHANED PAYMENT: payment ${row.payload?.razorpayPaymentId} has no escrow (tenant: ${row.tenant_id})`,
      );
      result.totalAlertsRaised++;

      // Re-emit ORDER_PAID to trigger escrow creation
      await this.outbox.publish(
        DomainEventType.ORDER_PAID,
        row.tenant_id,
        { ...row.payload, _reconciliation: true },
      );
    }
  }

  // ── 2. Stuck escrows ──────────────────────────────────────────────────────

  private async detectStuckEscrows(result: ReconciliationResult): Promise<void> {
    const stuck = await this.db.execute<{
      id: string; tenant_id: string; order_id: string;
      status: string; stuck_hours: number;
    }>(sql`
      SELECT
        id, tenant_id, order_id, status,
        EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600 AS stuck_hours
      FROM escrow_transactions
      WHERE status IN ('AWAITING_SUPPLIER_PAYMENT', 'ESCROW_CREATED')
        AND updated_at < NOW() - INTERVAL '24 hours'
      ORDER BY updated_at ASC
      LIMIT 50
    `);

    result.stuckEscrows = stuck.rows.length;

    for (const row of stuck.rows) {
      const hours = Math.round(row.stuck_hours);
      this.logger.warn(
        `STUCK ESCROW: ${row.id} (order: ${row.order_id}) in ${row.status} for ${hours}h`,
      );
      result.totalAlertsRaised++;
    }

    if (stuck.rows.length > 0) {
      await this.alerting.sendCritical({
        title:   `${stuck.rows.length} stuck escrow(s) require admin action`,
        message: stuck.rows
          .map(r => `Order ${r.order_id}: ${r.status} for ${Math.round(r.stuck_hours)}h`)
          .join('\n'),
      });
    }
  }

  // ── 3. Missing supplier fulfillment tasks ─────────────────────────────────

  private async detectMissingSupplierTasks(result: ReconciliationResult): Promise<void> {
    const missing = await this.db.execute<{
      escrow_id: string; tenant_id: string; order_id: string;
    }>(sql`
      SELECT e.id AS escrow_id, e.tenant_id, e.order_id
      FROM escrow_transactions e
      WHERE e.status = 'AWAITING_SUPPLIER_PAYMENT'
        AND e.created_at < NOW() - INTERVAL '1 hour'
        AND NOT EXISTS (
          SELECT 1 FROM supplier_fulfillment_tasks t
          WHERE t.escrow_id = e.id
        )
      LIMIT 20
    `);

    result.missingSupplierTasks = missing.rows.length;

    for (const row of missing.rows) {
      this.logger.error(
        `MISSING SUPPLIER TASK: escrow ${row.escrow_id} has no fulfillment task — replaying`,
      );
      result.totalAlertsRaised++;

      // Re-emit SUPPLIER_TASK_CREATED to trigger task creation
      await this.outbox.publish(
        DomainEventType.SUPPLIER_TASK_CREATED,
        row.tenant_id,
        { escrowId: row.escrow_id, orderId: row.order_id, _reconciliation: true },
      );
    }
  }

  // ── 4. Delivered without profit distribution ──────────────────────────────

  private async detectDeliveredWithoutProfit(result: ReconciliationResult): Promise<void> {
    const unCredited = await this.db.execute<{
      escrow_id: string; tenant_id: string; order_id: string;
      customer_paid_amount: string; razorpay_fee: string;
      supplier_product_cost: string; supplier_shipping_cost: string;
      tax_amount: string; admin_commission: string; currency: string;
    }>(sql`
      SELECT
        e.id AS escrow_id, e.tenant_id, e.order_id,
        e.customer_paid_amount, e.razorpay_fee,
        e.supplier_product_cost, e.supplier_shipping_cost,
        e.tax_amount, e.admin_commission, e.currency
      FROM escrow_transactions e
      WHERE e.status = 'DELIVERED'
        AND e.delivered_at < NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM outbox_events o
          WHERE o.event_type = 'PROFIT_DISTRIBUTED'
            AND o.payload->>'escrowId' = e.id::text
            AND o.status IN ('PENDING', 'SENT')
        )
      LIMIT 20
    `);

    result.deliveredWithoutProfit = unCredited.rows.length;

    for (const row of unCredited.rows) {
      const userProfit = +(
        +row.customer_paid_amount
        - +row.razorpay_fee
        - +row.supplier_product_cost
        - +row.supplier_shipping_cost
        - +row.tax_amount
        - +row.admin_commission
      ).toFixed(2);

      this.logger.error(
        `UNEARNED PROFIT: escrow ${row.escrow_id} delivered but ₹${userProfit} not distributed — replaying`,
      );
      result.totalAlertsRaised++;

      await this.outbox.publish(
        DomainEventType.PROFIT_DISTRIBUTED,
        row.tenant_id,
        {
          escrowId:   row.escrow_id,
          orderId:    row.order_id,
          userProfit,
          currency:   row.currency,
          _reconciliation: true,
        },
      );
    }
  }

  // ── Manual trigger (admin API) ────────────────────────────────────────────

  async runNow(): Promise<ReconciliationResult | null> {
    return this.reconcile();
  }
}
