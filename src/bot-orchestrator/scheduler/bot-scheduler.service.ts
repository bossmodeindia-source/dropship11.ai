/**
 * BotSchedulerService
 *
 * Cron-driven trigger that queries active bots, builds EnqueueBotRequest
 * batches, and delegates to BotJobDispatcher for enqueue.
 *
 * Design:
 *  - Scheduler is READ-ONLY with respect to AI logic — it only fetches bot
 *    metadata and calls orchestrator.enqueueBatch().
 *  - A Redis lock prevents concurrent scheduler runs across multiple instances.
 *  - Scheduler interval is adaptive: backs off when in WARNING backpressure state.
 *
 * Schedule:
 *   Default: every 60 seconds
 *   Override: SCHEDULER_INTERVAL_SECONDS env var
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql, and, lte, isNull, or } from 'drizzle-orm';
import Redis from 'ioredis';

import { DB_TOKEN } from '../../common/database/database.module';
import * as schema from '../../common/database/schema';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { BotJobDispatcher } from '../orchestrator/bot-job-dispatcher.service';
import { BackpressureService } from '../rate-limiter/backpressure.service';
import { EnqueueBotRequest } from '../orchestrator/bot-job.types';

const SCHEDULER_LOCK_KEY = 'scheduler:bot:lock';
const SCHEDULER_LOCK_TTL = 55;  // seconds — slightly less than 60s interval

@Injectable()
export class BotSchedulerService implements OnModuleDestroy {
  private readonly logger = new Logger(BotSchedulerService.name);
  private isRunning = false;

  constructor(
    @Inject(DB_TOKEN)       private readonly db:          NodePgDatabase<typeof schema>,
    @Inject(REDIS_CLIENT)   private readonly redis:        Redis,
    private readonly orchestrator: BotJobDispatcher,
    private readonly backpressure: BackpressureService,
  ) {}

  onModuleDestroy(): void {
    this.isRunning = false;
  }

  /**
   * Main scheduler tick — runs every minute.
   * All other timings are derived from this base interval.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleBotCycles(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('[Scheduler] Previous cycle still running — skipping tick');
      return;
    }

    // Distributed lock — only one instance runs the scheduler at a time
    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      this.logger.debug('[Scheduler] Lock held by another instance — skipping');
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();

    try {
      // ── Check backpressure before doing any work ──────────────────────────
      const bp = await this.backpressure.evaluate();
      if (!bp.allowed) {
        this.logger.warn(
          `[Scheduler] System overloaded (totalWaiting=${bp.totalWaiting}) — skipping cycle`,
        );
        return;
      }

      if (bp.state === 'warning') {
        // Warning state: only schedule 50% of bots this tick
        this.logger.warn('[Scheduler] WARNING state — scheduling partial batch (50%)');
      }

      // ── Fetch due bots from DB ────────────────────────────────────────────
      const bots = await this.fetchDueBots(bp.state === 'warning' ? 0.5 : 1.0);

      if (!bots.length) {
        this.logger.debug('[Scheduler] No bots due for execution this cycle');
        return;
      }

      // ── Build enqueue requests ────────────────────────────────────────────
      const requests: EnqueueBotRequest[] = bots.map((bot) => ({
        tenant_id:          bot.tenantId,
        bot_id:             bot.id,
        execution_type:     'cycle',
        requested_priority: bot.priority as 'low' | 'normal' | 'high' | undefined,
      }));

      // ── Delegate to orchestrator ──────────────────────────────────────────
      const result = await this.orchestrator.enqueueBatch(requests);

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[Scheduler] Cycle complete — enqueued=${result.enqueued} ` +
        `skipped=${result.skipped} duration=${durationMs}ms`,
      );

      // Update last-scheduled timestamps for enqueued bots
      if (result.enqueued > 0) {
        await this.markBotsScheduled(bots.slice(0, result.enqueued).map((b) => b.id));
      }
    } catch (err) {
      this.logger.error(`[Scheduler] Fatal scheduler error: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.isRunning = false;
      await this.releaseLock();
    }
  }

  /**
   * 10-minute heartbeat — re-enqueue any jobs that got stuck in 'processing'
   * state for more than 5 minutes (handles crashed workers).
   */
  @Cron('0 */10 * * * *')
  async recoverStalledJobs(): Promise<void> {
    const staleThreshold = new Date(Date.now() - 5 * 60_000);

    try {
      const stalled = await this.db
        .select()
        .from(schema.botJobRecords)
        .where(
          and(
            eq(schema.botJobRecords.status, 'processing'),
            lte(schema.botJobRecords.createdAt, staleThreshold),
          ),
        )
        .limit(50);

      if (!stalled.length) return;

      this.logger.warn(`[Scheduler] Recovering ${stalled.length} stalled jobs`);

      for (const job of stalled) {
        await this.orchestrator.enqueueBot({
          tenant_id:      job.tenantId,
          bot_id:         job.botId,
          execution_type: job.executionType as 'cycle' | 'test' | 'scale',
        });
        // Mark original as abandoned
        await this.db
          .update(schema.botJobRecords)
          .set({ status: 'abandoned' })
          .where(eq(schema.botJobRecords.jobId, job.jobId ?? ''));
      }
    } catch (err) {
      this.logger.error(`[Scheduler] Recovery error: ${(err as Error).message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ══════════════════════════════════════════════════════════════════════════

  private async fetchDueBots(fraction = 1.0): Promise<
    Array<{ id: string; tenantId: string; priority?: string | number }>
  > {
    const now = new Date();

    const rows = await this.db
      .select({
        id:       schema.bots.id,
        tenantId: schema.bots.userId,
        priority: schema.bots.priority,
      })
      .from(schema.bots)
      .where(
        and(
          eq(schema.bots.isActive, true),
          or(
            isNull(schema.bots.lastScheduledAt),
            lte(schema.bots.lastScheduledAt, new Date(now.getTime() - 55_000)),
          ),
        ),
      )
      .limit(Math.ceil(1_000 * fraction));  // cap batch size; 1000 > 800 concurrent

    return rows;
  }

  private async markBotsScheduled(botIds: string[]): Promise<void> {
    if (!botIds.length) return;
    // Bulk update — use raw SQL for efficiency on large batches
    const placeholders = botIds.map((_, i) => `$${i + 2}`).join(', ');
    try {
      await this.db.execute(
        sql`UPDATE bots SET last_scheduled_at = ${new Date()} WHERE id IN (${sql.raw(botIds.map(id => `'${id}'`).join(', '))})`,
      );
    } catch (err) {
      this.logger.warn(`[Scheduler] Failed to mark bots scheduled: ${(err as Error).message}`);
    }
  }

  private async acquireLock(): Promise<boolean> {
    const result = await this.redis.set(
      SCHEDULER_LOCK_KEY,
      '1',
      'EX', SCHEDULER_LOCK_TTL,
      'NX',
    );
    return result === 'OK';
  }

  private async releaseLock(): Promise<void> {
    await this.redis.del(SCHEDULER_LOCK_KEY);
  }
}
