/**
 * disaster-recovery.service.ts — V65 UPDATED
 *
 * Automatic recovery from:
 *   - Unfinished commerce cycles (process crash)
 *   - Pending orders (DB/Shopify disconnect)
 *   - Orphan distributed locks (TTL cleanup)
 *   - Pending payouts (Razorpay webhook miss)
 *
 * V65 ADDITIONS:
 *   - recoverStuckEscrows()             — alert on escrows stuck > 24h
 *   - recoverOrphanedFulfillmentTasks() — re-emit SUPPLIER_TASK_CREATED via outbox
 *   - recoverDeliveredWithoutWallet()   — re-emit PROFIT_DISTRIBUTED via outbox
 */

import {
  Injectable, Logger, OnModuleInit,
} from '@nestjs/common';
import { Inject }                from '@nestjs/common';
import { Cron }                  from '@nestjs/schedule';
import { NodePgDatabase }        from 'drizzle-orm/node-postgres';
import { Queue }                 from 'bullmq';
import { InjectQueue }           from '@nestjs/bullmq';
import { Redis }                 from 'ioredis';
import { InjectRedis }           from '../common/redis/inject-redis';
import { eq, and, lte, sql }    from 'drizzle-orm';

import { DB_TOKEN }               from '../common/database/database.module';
import * as schema                from '../common/database/schema';
import { AlertingService }        from '../alerting/alerting.service';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { CanonicalQueue }         from '../queue/canonical-queues';
import { OutboxService }          from '../common/outbox/outbox.service';  // V65
import { DomainEventType }        from '../common/events/domain-events';   // V65

@Injectable()
export class DisasterRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(DisasterRecoveryService.name);
  private recoveryInProgress = false;

  constructor(
    @Inject(DB_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,

    private readonly alerting:  AlertingService,
    private readonly lockSvc:   DistributedLockService,
    private readonly outbox:    OutboxService,   // V65

    @InjectRedis()
    private readonly redis: Redis,

    @InjectQueue(CanonicalQueue.ORDER_PROCESSING)
    private readonly orderQueue: Queue,

    @InjectQueue(CanonicalQueue.SUPPLIER_FULFILLMENT)
    private readonly fulfillmentQueue: Queue,

    @InjectQueue(CanonicalQueue.CAMPAIGN_LAUNCH)
    private readonly campaignQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('DisasterRecoveryService: running startup reconciliation...');
    await this.runRecovery('startup');
  }

  // ── Scheduled recovery: every 5 minutes ───────────────────────────────────
  @Cron('*/5 * * * *', { name: 'disaster-recovery' })
  async scheduledRecovery(): Promise<void> {
    await this.runRecovery('scheduled');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN RECOVERY RUNNER
  // ══════════════════════════════════════════════════════════════════════════

  async runRecovery(trigger: 'startup' | 'scheduled' | 'manual'): Promise<{
    staleCycles: number;
    pendingOrders: number;
    pendingPayouts: number;
    staleLocks: number;
    errors: string[];
  }> {
    if (this.recoveryInProgress) {
      this.logger.debug('Recovery already in progress, skipping');
      return { staleCycles: 0, pendingOrders: 0, pendingPayouts: 0, staleLocks: 0, errors: [] };
    }

    this.recoveryInProgress = true;
    const stats = { staleCycles: 0, pendingOrders: 0, pendingPayouts: 0, staleLocks: 0, errors: [] as string[] };

    try {
      this.logger.log(`Recovery run started: trigger=${trigger}`);

      const [cycles, orders, payouts, locks] = await Promise.allSettled([
        this.recoverStaleCycles(),
        this.recoverPendingOrders(),
        this.recoverPendingPayouts(),
        this.lockSvc.cleanupStaleLocks(),
      ]);

      if (cycles.status  === 'fulfilled') stats.staleCycles   = cycles.value;
      else stats.errors.push(`cycle recovery: ${cycles.reason}`);

      if (orders.status  === 'fulfilled') stats.pendingOrders = orders.value;
      else stats.errors.push(`order recovery: ${orders.reason}`);

      if (payouts.status === 'fulfilled') stats.pendingPayouts = payouts.value;
      else stats.errors.push(`payout recovery: ${payouts.reason}`);

      if (stats.errors.length > 0) {
        await this.alerting.sendWarn({ title: 'RECOVERY_PARTIAL_FAILURE', message: 'platform', data: {
          trigger, errors: stats.errors,
        } });
      }

      this.logger.log(
        `Recovery complete: trigger=${trigger} ` +
        `staleCycles=${stats.staleCycles} pendingOrders=${stats.pendingOrders} ` +
        `pendingPayouts=${stats.pendingPayouts}`,
      );
    } finally {
      this.recoveryInProgress = false;
    }

    return stats;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RECOVERY TASKS — V60 ORIGINAL
  // ══════════════════════════════════════════════════════════════════════════

  private async recoverStaleCycles(): Promise<number> {
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);

    const staleCycles = await this.db
      .select()
      .from(schema.commerceCycles)
      .where(
        and(
          eq(schema.commerceCycles.status, 'running'),
          lte(schema.commerceCycles.updatedAt, staleThreshold),
        ),
      )
      .limit(50);

    let recovered = 0;
    for (const cycle of staleCycles) {
      try {
        await this.db
          .update(schema.commerceCycles)
          .set({
            status:    'failed',
            steps:     JSON.stringify({
              ...JSON.parse(cycle.steps ?? '{}'),
              RECOVERY: { status: 'failed', error: 'Cycle timed out — marked failed during recovery', ts: Date.now() },
            }),
            updatedAt: new Date(),
          })
          .where(eq(schema.commerceCycles.id, cycle.id));

        recovered++;
        this.logger.warn(`Stale cycle recovered: ${cycle.id} bot=${cycle.botId}`);
        await this.alerting.sendWarn({ title: 'STALE_CYCLE_RECOVERED', message: cycle.tenantId ?? 'system', data: {
          cycleId: cycle.id, botId: cycle.botId, staleMs: Date.now() - new Date(cycle.updatedAt).getTime(),
        } });
      } catch (err) {
        this.logger.error(`Failed to recover cycle ${cycle.id}:`, err);
      }
    }
    return recovered;
  }

  private async recoverPendingOrders(): Promise<number> {
    const threshold = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const pendingOrders = await this.db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.status, 'received'), lte(schema.orders.createdAt, threshold)))
      .limit(100);

    let recovered = 0;
    for (const order of pendingOrders) {
      try {
        const jobId = `order-recovery:${order.id}`;
        const existing = await this.orderQueue.getJob(jobId);
        if (existing) continue;

        await this.orderQueue.add(
          'process-new',
          { orderId: order.id, tenantId: order.userId ?? 'system', isRecovery: true },
          { jobId, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
        );
        recovered++;
        this.logger.log(`Pending order re-queued: ${order.id}`);
      } catch (err) {
        this.logger.error(`Failed to recover order ${order.id}:`, err);
      }
    }
    return recovered;
  }

  private async recoverPendingPayouts(): Promise<number> {
    const threshold = new Date(Date.now() - 4 * 60 * 60 * 1000);

    const stuckPayouts = await this.db
      .select()
      .from(schema.withdrawals)
      .where(and(eq(schema.withdrawals.status, 'processing'), lte(schema.withdrawals.updatedAt, threshold)))
      .limit(50);

    let alerted = 0;
    for (const payout of stuckPayouts) {
      try {
        await this.alerting.sendCritical({ title: 'PAYOUT_STUCK', message: 'platform', data: {
          withdrawalId: payout.id, userId: payout.userId, amount: payout.amount,
          stuckSince: payout.updatedAt, stuckMs: Date.now() - new Date(payout.updatedAt).getTime(),
        } });

        await this.db
          .update(schema.withdrawals)
          .set({ status: 'approved', updatedAt: new Date() })
          .where(eq(schema.withdrawals.id, payout.id));

        alerted++;
        this.logger.warn(`Stuck payout reset: ${payout.id} user=${payout.userId}`);
      } catch (err) {
        this.logger.error(`Failed to recover payout ${payout.id}:`, err);
      }
    }
    return alerted;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // V65 ADDITIONS — Escrow Recovery
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Detects escrows stuck in AWAITING_SUPPLIER_PAYMENT or ESCROW_CREATED > 24h.
   * Sends a critical alert — does NOT auto-advance (admin must confirm manually).
   */
  @Cron('0 */30 * * * *')  // every 30 minutes
  async recoverStuckEscrows(): Promise<void> {
    try {
      const stuck = await this.db.execute(sql`
        SELECT id, tenant_id, order_id, status,
               EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600 AS hours_stuck
        FROM escrow_transactions
        WHERE status IN ('AWAITING_SUPPLIER_PAYMENT', 'ESCROW_CREATED')
          AND updated_at < NOW() - INTERVAL '24 hours'
        ORDER BY updated_at ASC
        LIMIT 20
      `);

      if ((stuck.rows as any[]).length === 0) return;

      this.logger.warn(`[Recovery] ${stuck.rows.length} escrow(s) stuck > 24h — sending alert`);

      for (const row of stuck.rows as any[]) {
        this.logger.error(
          `Stuck escrow: ${row.id} | order: ${row.order_id} | status: ${row.status} | ${Math.round(row.hours_stuck)}h`,
        );
      }

      await this.alerting.sendCritical({
        title:   `${stuck.rows.length} escrow(s) require admin action`,
        message: (stuck.rows as any[])
          .map((r: any) => `Order ${r.order_id}: ${r.status} for ${Math.round(r.hours_stuck)}h`)
          .join('\n'),
      });
    } catch (err) {
      this.logger.error(`Escrow recovery check failed: ${(err as Error).message}`);
    }
  }

  /**
   * Detects escrows with no supplier fulfillment task and re-emits via outbox.
   * Safe to re-run: outbox deduplication prevents duplicate tasks.
   */
  @Cron('0 */15 * * * *')  // every 15 minutes
  async recoverOrphanedFulfillmentTasks(): Promise<void> {
    try {
      const orphaned = await this.db.execute(sql`
        SELECT e.id AS escrow_id, e.tenant_id, e.order_id
        FROM escrow_transactions e
        WHERE e.status = 'AWAITING_SUPPLIER_PAYMENT'
          AND e.created_at < NOW() - INTERVAL '1 hour'
          AND NOT EXISTS (
            SELECT 1 FROM supplier_fulfillment_tasks t WHERE t.escrow_id = e.id
          )
        LIMIT 10
      `);

      for (const row of orphaned.rows as any[]) {
        this.logger.warn(`[Recovery] Orphaned escrow ${row.escrow_id} — re-emitting supplier task`);
        await this.outbox.publish(
          DomainEventType.SUPPLIER_TASK_CREATED,
          row.tenant_id,
          { escrowId: row.escrow_id, orderId: row.order_id, _recovery: true },
        );
      }
    } catch (err) {
      this.logger.error(`Orphan task recovery failed: ${(err as Error).message}`);
    }
  }

  /**
   * Detects orders DELIVERED but user profit not credited to wallet.
   * Re-emits PROFIT_DISTRIBUTED event for each uncredited delivery.
   */
  @Cron('0 */20 * * * *')  // every 20 minutes
  async recoverDeliveredWithoutWallet(): Promise<void> {
    try {
      const uncredited = await this.db.execute(sql`
        SELECT e.id, e.tenant_id, e.order_id,
               e.customer_paid_amount, e.razorpay_fee,
               e.supplier_product_cost, e.supplier_shipping_cost,
               e.tax_amount, e.admin_commission, e.currency
        FROM escrow_transactions e
        WHERE e.status = 'DELIVERED'
          AND e.delivered_at < NOW() - INTERVAL '2 hours'
          AND NOT EXISTS (
            SELECT 1 FROM wallet_transactions w
            WHERE w.reference_id = e.id AND w.type = 'PROFIT_CREDIT'
          )
        LIMIT 10
      `);

      for (const r of uncredited.rows as any[]) {
        const userProfit = +(
          +r.customer_paid_amount - +r.razorpay_fee
          - +r.supplier_product_cost - +r.supplier_shipping_cost
          - +r.tax_amount - +r.admin_commission
        ).toFixed(2);

        this.logger.warn(`[Recovery] Uncredited profit for escrow ${r.id}: ₹${userProfit} — re-emitting`);

        await this.outbox.publish(
          DomainEventType.PROFIT_DISTRIBUTED,
          r.tenant_id,
          { escrowId: r.id, orderId: r.order_id, userProfit, currency: r.currency, _recovery: true },
        );
      }
    } catch (err) {
      this.logger.error(`Wallet recovery failed: ${(err as Error).message}`);
    }
  }

  // ── Manual trigger (admin API) ─────────────────────────────────────────────
  async triggerManualRecovery() {
    return this.runRecovery('manual');
  }
}
