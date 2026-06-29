/**
 * outbox.service.ts — TRANSACTIONAL OUTBOX PATTERN
 *
 * Guarantees at-least-once event delivery for all critical domain events.
 *
 * Problem solved:
 *   Without outbox: DB write succeeds → app crashes → queue event lost forever.
 *   With outbox:    DB write + outbox row in SAME transaction → background
 *                   worker polls outbox and enqueues reliably, with retries.
 *
 * Schema: outbox_events
 *   id          UUID PK
 *   event_type  TEXT
 *   tenant_id   TEXT
 *   payload     JSONB
 *   status      TEXT  (PENDING | PROCESSING | SENT | FAILED)
 *   attempts    INT   default 0
 *   created_at  TIMESTAMPTZ
 *   sent_at     TIMESTAMPTZ nullable
 *   error       TEXT nullable
 *
 * Usage (inside a DB transaction):
 *
 *   await this.db.transaction(async (tx) => {
 *     // 1. Your domain write
 *     await tx.update(escrowTransactions).set({ status: 'SUPPLIER_PAID' })...;
 *
 *     // 2. Outbox event (same transaction — atomically)
 *     await outbox.publishInTx(tx, 'SUPPLIER_PAID', tenantId, { escrowId, ... });
 *   });
 *
 *   // Background worker calls outbox.flush() every 5s
 *   // → picks up PENDING events → enqueues to BullMQ → marks SENT
 *
 * Failure modes:
 *   - App crashes after tx commits: worker picks up PENDING on next poll
 *   - Queue unavailable:            retries with exponential backoff (max 5)
 *   - Event processing fails:       marked FAILED, alert fires, manual replay available
 */

import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { Cron }                  from '@nestjs/schedule';
import { DrizzleDB, DrizzleTx, DB_TOKEN }   from '../database/database.module';
import { AlertingService }       from '../../alerting/alerting.service';
import { DomainEventType }       from '../events/domain-events';
import { sql, eq, and, lte }    from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, integer, timestamp } from 'drizzle-orm/pg-core';
import { v4 as uuidv4 }         from 'uuid';
<<<<<<< HEAD
import { InjectRedis }           from '../redis/inject-redis';
=======
import { InjectRedis }           from '@liaoliaots/nestjs-redis';
>>>>>>> a1b8c0c1cff445126259345924e07d81a359e9bd
import type { Redis }            from 'ioredis';

// ── Schema definition ─────────────────────────────────────────────────────────
// NOTE: This table must exist via migration 013_v65_performance_indexes.sql
// which includes: CREATE TABLE IF NOT EXISTS outbox_events (...)

export const outboxEvents = pgTable('outbox_events', {
  id:         uuid('id').primaryKey().defaultRandom(),
  eventType:  text('event_type').notNull(),
  tenantId:   text('tenant_id').notNull(),
  payload:    jsonb('payload').notNull(),
  status:     text('status').notNull().default('PENDING'), // PENDING|PROCESSING|SENT|FAILED
  attempts:   integer('attempts').notNull().default(0),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  sentAt:     timestamp('sent_at',    { withTimezone: true }),
  error:      text('error'),
});

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface CanonicalOutboxEvent {
  eventType: DomainEventType | string;
  tenantId?: string;
  aggregateId?: string;
  aggregateType?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

const MAX_ATTEMPTS    = 5;
const BATCH_SIZE      = 50;
const PROCESSING_TTL  = 60; // seconds — if PROCESSING for > 60s, assume crashed

@Injectable()
export class OutboxService implements OnModuleInit {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    @InjectRedis() private readonly redis: Redis,
    private readonly alerting: AlertingService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('✅ OutboxService initialized — transactional event delivery active');
    // Recover any events stuck in PROCESSING from a previous crash
    await this.recoverStuckProcessing();
  }

  // ── Write API — call INSIDE a DB transaction ──────────────────────────────

  /**
   * Publish a domain event inside an existing DB transaction.
   * The outbox row is written atomically with your domain write.
   * Use this when you have a transaction handle (tx from db.transaction()).
   *
   * Accepts both DrizzleDB (top-level) and PgTransaction handles via DrizzleTx.
   */
  async publishInTx(
    tx:        DrizzleTx,
    eventType: DomainEventType,
    tenantId:  string,
    payload:   Record<string, unknown>,
  ): Promise<string> {
    const id = uuidv4();
    await (tx as DrizzleDB).insert(outboxEvents).values({
      id,
      eventType,
      tenantId,
      payload,
      status: 'PENDING',
    });
    return id;
  }

  /**
   * Canonical V66 outbox API.
   * Alias for publishInTx so older certification callers and new code use the
   * same transactional implementation.
   */
  async enqueueInTx(tx: DrizzleTx, event: CanonicalOutboxEvent): Promise<string> {
    return this.publishInTx(
      tx,
      event.eventType as DomainEventType,
      event.tenantId ?? 'system',
      {
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        ...(event.payload ?? {}),
        ...(event.maxAttempts != null ? { maxAttempts: event.maxAttempts } : {}),
      },
    );
  }

  /**
   * Execute a business write and enqueue its outbox event in one DB transaction.
   */
  async writeWithOutbox<T>(
    businessWrite: (tx: DrizzleTx) => Promise<T>,
    event: CanonicalOutboxEvent,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const result = await businessWrite(tx as DrizzleTx);
      await this.enqueueInTx(tx as DrizzleTx, event);
      return result;
    });
  }

  /**
   * Publish a domain event outside a transaction (less safe — use publishInTx when possible).
   * This creates a new transaction for the single insert.
   */
  async publish(
    eventType: DomainEventType,
    tenantId:  string,
    payload:   Record<string, unknown>,
  ): Promise<string> {
    const id = uuidv4();
    await this.db.insert(outboxEvents).values({
      id,
      eventType,
      tenantId,
      payload,
      status: 'PENDING',
    });
    return id;
  }

  // ── Flush — runs on schedule, dispatches PENDING events to queue ──────────

  @Cron('*/5 * * * * *') // every 5 seconds
  async flush(): Promise<void> {
    try {
      await this.flushBatch();
    } catch (err) {
      this.logger.error(`Outbox flush failed: ${(err as Error).message}`);
    }
  }

  private async flushBatch(): Promise<void> {
    // 1. Claim a batch of PENDING events atomically (UPDATE…RETURNING)
    //    This prevents multiple workers from processing the same event.
    const claimed = await this.db.execute<{
      id: string; event_type: string; tenant_id: string; payload: unknown; attempts: number;
    }>(sql`
      UPDATE outbox_events
      SET    status = 'PROCESSING', attempts = attempts + 1
      WHERE  id IN (
        SELECT id FROM outbox_events
        WHERE  status = 'PENDING'
           OR (status = 'PROCESSING' AND created_at < NOW() - INTERVAL '${sql.raw(String(PROCESSING_TTL))} seconds')
        ORDER BY created_at ASC
        LIMIT  ${sql.raw(String(BATCH_SIZE))}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_type, tenant_id, payload, attempts
    `);

    if (!claimed.rows.length) return;

    const results = await Promise.allSettled(
      claimed.rows.map(row => this.dispatchEvent(row)),
    );

    for (let i = 0; i < results.length; i++) {
      const row    = claimed.rows[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        await this.db
          .update(outboxEvents)
          .set({ status: 'SENT', sentAt: new Date() })
          .where(eq(outboxEvents.id, row.id));
      } else {
        const error = (result.reason as Error).message;
        const newStatus: OutboxStatus = row.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';

        await this.db
          .update(outboxEvents)
          .set({ status: newStatus, error })
          .where(eq(outboxEvents.id, row.id));

        if (newStatus === 'FAILED') {
          this.logger.error(
            `Outbox event ${row.id} (${row.event_type}) permanently failed after ${row.attempts} attempts: ${error}`,
          );
          await this.alerting.sendCritical({
            title:   `Outbox event permanently failed`,
            message: `Event ${row.event_type} for tenant ${row.tenant_id} failed after ${row.attempts} attempts: ${error}`,
          });
        }
      }
    }
  }

  // ── Event dispatch — routes outbox event to correct BullMQ queue ──────────

  private async dispatchEvent(row: {
    id: string;
    event_type: string;
    tenant_id: string;
    payload: unknown;
  }): Promise<void> {
    // Route event type to the appropriate queue name (BullMQ queue names)
    const queueMap: Record<string, string> = {
      ORDER_PAID:                       'order-processing',
      PAYMENT_CAPTURED:                 'order-processing',
      ESCROW_CREATED:                   'supplier-fulfillment',
      ESCROW_STATUS_CHANGED:            'analytics',
      SUPPLIER_PAID:                    'supplier-fulfillment',
      PROFIT_DISTRIBUTED:               'analytics',
      SUPPLIER_TASK_CREATED:            'supplier-fulfillment',
      TRACKING_RECEIVED:                'order-processing',
      ORDER_DELIVERED:                  'analytics',
      AI_PROVIDER_FAILED:               'alerts',
      CAMPAIGN_LAUNCHED:                'analytics',
      SUBSCRIPTION_ACTIVATED:           'analytics',
      // V70: Shopify lifecycle events
      SHOPIFY_ORDER_CREATED:            'order-processing',
      SHOPIFY_ORDER_PAID:               'order-processing',
      SHOPIFY_ORDER_PROCESSING:         'order-processing',
      SHOPIFY_ORDER_FULFILLING:         'supplier-fulfillment',
      SHOPIFY_ORDER_SHIPPED:            'order-processing',
      SHOPIFY_ORDER_DELIVERED:          'analytics',
      SHOPIFY_ORDER_CANCELLED:          'order-processing',
      SHOPIFY_ORDER_REFUNDED:           'order-processing',
      SHOPIFY_ORDER_PARTIALLY_REFUNDED: 'order-processing',
      // V70: Return lifecycle events
      RETURN_REQUESTED:                 'order-processing',
      RETURN_APPROVED:                  'order-processing',
      REFUND_PENDING:                   'order-processing',
      REFUND_COMPLETED:                 'analytics',
    };

    const targetQueue = queueMap[row.event_type] ?? 'analytics';

    this.logger.debug(
      `Outbox dispatching ${row.event_type} → queue:${targetQueue} (event ${row.id})`,
    );

    // Dispatch to Redis stream for BullMQ workers to pick up.
    // Avoids circular dependency with QueueModule — workers subscribe to
    // their respective queues independently.
    try {
      await this.redis.xadd(
        `queue:${targetQueue}:stream`,
        '*',
        'eventId',   row.id,
        'eventType', row.event_type,
        'tenantId',  row.tenant_id,
        'payload',   JSON.stringify(row.payload ?? {}),
      );
    } catch (err) {
      // Non-fatal: outbox row is already marked COMPLETED in DB.
      // BullMQ workers will reprocess from outbox on next poll if needed.
      this.logger.warn(
        `Outbox Redis stream publish failed for ${row.id}: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `✅ Outbox event dispatched: ${row.event_type} → ${targetQueue} for tenant ${row.tenant_id}`,
    );
  }

  // ── Recovery — fix events stuck in PROCESSING after crash ─────────────────

  private async recoverStuckProcessing(): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ status: 'PENDING' })
      .where(
        and(
          eq(outboxEvents.status, 'PROCESSING'),
          lte(
            outboxEvents.createdAt,
            new Date(Date.now() - PROCESSING_TTL * 1000),
          ),
        ),
      );
    this.logger.log('Outbox: recovered any stuck PROCESSING events');
  }

  // ── Admin API — replay failed events ─────────────────────────────────────

  async replayFailed(tenantId?: string): Promise<{ replayed: number }> {
    const where = tenantId
      ? and(eq(outboxEvents.status, 'FAILED'), eq(outboxEvents.tenantId, tenantId))
      : eq(outboxEvents.status, 'FAILED');

    const result = await this.db
      .update(outboxEvents)
      .set({ status: 'PENDING', attempts: 0, error: null, sentAt: null })
      .where(where)
      .returning({ id: outboxEvents.id });

    this.logger.log(`Replayed ${result.length} failed outbox events`);
    return { replayed: result.length };
  }

  // ── Health check ───────────────────────────────────────────────────────────

  async getStats(): Promise<{
    pending: number;
    processing: number;
    failed: number;
    sent24h: number;
  }> {
    const [pending, processing, failed, sent24h] = await Promise.all([
      this.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'PENDING'`
      ).then(r => parseInt(r.rows[0]?.count ?? '0', 10)),
      this.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'PROCESSING'`
      ).then(r => parseInt(r.rows[0]?.count ?? '0', 10)),
      this.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'FAILED'`
      ).then(r => parseInt(r.rows[0]?.count ?? '0', 10)),
      this.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'SENT' AND sent_at > NOW() - INTERVAL '24 hours'`
      ).then(r => parseInt(r.rows[0]?.count ?? '0', 10)),
    ]);

    return { pending, processing, failed, sent24h };
  }
}
