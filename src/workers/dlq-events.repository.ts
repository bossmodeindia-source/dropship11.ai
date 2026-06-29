import { Injectable, Inject, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

/**
 * Persists a permanent audit record every time an order reaches the DLQ.
 * This is the fallback of last resort — if alerts fail, this table allows
 * ops to query and replay dead-lettered orders.
 */
@Injectable()
export class DlqEventsRepository {
  private readonly logger = new Logger(DlqEventsRepository.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  async record(params: {
    orderId:         string;
    userId?:         string;
    platformOrderId?: string;
    supplierType?:   string;
    jobId?:          string;
    attemptsMade:    number;
    failureReason?:  string;
  }): Promise<void> {
    try {
      await this.db.execute(
        // Use raw SQL since dlq_events may not be in the Drizzle schema yet
        // (it's added by the migration script). Safe to use parameterized query.
        schema.dlqEvents
          ? this.db
              .insert(schema.dlqEvents)
              .values({
                orderId:         params.orderId,
                userId:          params.userId ?? null,
                platformOrderId: params.platformOrderId ?? null,
                supplierType:    params.supplierType ?? null,
                jobId:           params.jobId ?? null,
                attemptsMade:    params.attemptsMade,
                failureReason:   params.failureReason ?? null,
                alerted:         false,
              })
          : (this.db.$client as any).query(
              `INSERT INTO dlq_events
                (order_id, user_id, platform_order_id, supplier_type, job_id, attempts_made, failure_reason)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                params.orderId,
                params.userId ?? null,
                params.platformOrderId ?? null,
                params.supplierType ?? null,
                params.jobId ?? null,
                params.attemptsMade,
                params.failureReason ?? null,
              ],
            ),
      );
      this.logger.debug(`DLQ event recorded for orderId=${params.orderId}`);
    } catch (err) {
      // Non-fatal: DLQ record failure must never crash the worker
      this.logger.error(
        `Failed to record DLQ event for orderId=${params.orderId}: ${(err as Error).message}`,
      );
    }
  }

  async markAlerted(orderId: string): Promise<void> {
    try {
      await (this.db.$client as import('pg').Pool).query(
        `UPDATE dlq_events SET alerted = TRUE, alerted_at = NOW()
         WHERE order_id = $1 AND alerted = FALSE`,
        [orderId],
      );
    } catch (err) {
      this.logger.error(`markAlerted failed orderId=${orderId}: ${(err as Error).message}`);
    }
  }
}
