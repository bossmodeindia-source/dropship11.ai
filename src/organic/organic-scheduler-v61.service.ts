/**
 * OrganicSchedulerV61
 *
 * Polls the V61 `organic_publish_jobs` table every 2 minutes for rows
 * with status='scheduled' whose scheduled_at <= NOW() and dispatches
 * them to the ORGANIC_POSTING queue as 'retry-scheduled' jobs.
 *
 * WHY A SEPARATE SCHEDULER (not modifying OrganicScheduler):
 *   OrganicScheduler reads from the legacy Drizzle `organicPosts` table (V60).
 *   V61 TenantOrganicPublisherService writes to `organic_publish_jobs` (V61).
 *   These are two different tables. Modifying OrganicScheduler risks breaking
 *   V60 behavior. This scheduler handles ONLY V61 records.
 *
 * SAFE DISPATCH PATTERN:
 *   - Batch-update rows to 'dispatching' before enqueueing to prevent double-dispatch
 *   - If enqueue fails, roll back to 'scheduled'
 *   - Max 50 rows per tick to avoid thundering-herd on Redis
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import { CanonicalQueue } from '../queue/canonical-queues';

const BATCH_SIZE = 50;

@Injectable()
export class OrganicSchedulerV61 {
  private readonly logger = new Logger(OrganicSchedulerV61.name);

  constructor(
    @Inject(DB_POOL)
    private readonly db: Pool,

    @InjectQueue(CanonicalQueue.ORGANIC_POSTING)
    private readonly organicQueue: Queue,
  ) {}

  /**
   * Every 2 minutes: find scheduled V61 organic posts that are due and dispatch them.
   */
  @Cron(CronExpression.EVERY_MINUTE)  // runs every minute, batch-size limits throughput
  async dispatchDueScheduledPosts(): Promise<void> {
    // Atomically claim up to BATCH_SIZE due rows — prevents concurrent workers from
    // dispatching the same post twice.
    const claimed = await this.db.query(
      `UPDATE organic_publish_jobs
       SET status = 'dispatching', updated_at = NOW()
       WHERE id IN (
         SELECT id FROM organic_publish_jobs
         WHERE status = 'scheduled'
           AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id`,
      [BATCH_SIZE],
    );

    if (claimed.rows.length === 0) return;

    this.logger.log(`Dispatching ${claimed.rows.length} due scheduled organic posts`);

    const results = await Promise.allSettled(
      claimed.rows.map(row =>
        this.organicQueue.add(
          'retry-scheduled',
          { publishJobId: row.id, tenantId: row.tenant_id },
          {
            attempts: 3,
            backoff:  { type: 'exponential', delay: 10_000 },
            removeOnComplete: { count: 200 },
            removeOnFail:     { count: 100 },
          },
        ),
      ),
    );

    // Roll back any rows that failed to enqueue
    const failed = claimed.rows.filter((_, i) => results[i].status === 'rejected');
    if (failed.length > 0) {
      const ids = failed.map(r => r.id);
      await this.db.query(
        `UPDATE organic_publish_jobs
         SET status='scheduled', updated_at=NOW()
         WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      this.logger.error(
        `Failed to enqueue ${failed.length} scheduled posts — rolled back to 'scheduled': ` +
        ids.join(', '),
      );
    }

    const dispatched = claimed.rows.length - failed.length;
    if (dispatched > 0) {
      this.logger.log(`${dispatched} organic posts dispatched to queue`);
    }
  }

  /**
   * Every 30 minutes: clean up rows stuck in 'dispatching' or 'publishing' for > 1 hour.
   * These represent crashed workers. Reset them to 'scheduled' so they retry.
   */
  @Cron('*/30 * * * *')
  async recoverStalledPosts(): Promise<void> {
    const result = await this.db.query(
      `UPDATE organic_publish_jobs
       SET status = 'scheduled', updated_at = NOW()
       WHERE status IN ('dispatching', 'publishing')
         AND updated_at < NOW() - INTERVAL '1 hour'
       RETURNING id`,
    );

    if (result.rows.length > 0) {
      this.logger.warn(
        `Recovered ${result.rows.length} stalled organic post(s) from dispatching/publishing state`,
      );
    }
  }
}
