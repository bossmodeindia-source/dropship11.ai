/**
 * BotDlqWorker
 *
 * Consumes jobs from the bot_dlq queue. Every job here represents a bot
 * execution that exhausted all retry attempts.
 *
 * Responsibilities:
 *   1. Parse and validate the DLQ payload
 *   2. Persist a permanent failure audit record (never auto-deleted)
 *   3. Send critical alert to ops (webhook / email)
 *   4. Mark the bot as suspended if it has > N consecutive failures
 *   5. Acknowledge the job (never re-queue from DLQ — human intervention required)
 *
 * Concurrency is intentionally low (2) — DLQ volume should be near-zero in
 * a healthy system. High DLQ throughput is itself a signal of systemic failure.
 */

import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject,
} from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';

import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { DB_TOKEN } from '../../common/database/database.module';
import * as schema from '../../common/database/schema';
import { NotificationsService } from '../../notifications/notifications.service';
import { BotDlqPayload } from '../orchestrator/bot-job.types';
import { BOT_DLQ } from '../queues/bot-queue.constants';

/** How many consecutive DLQ failures before a bot is auto-suspended. */
const AUTO_SUSPEND_THRESHOLD = 3;

@Injectable()
export class BotDlqWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotDlqWorker.name);
  private worker!: Worker<BotDlqPayload>;

  constructor(
    @Inject(REDIS_CLIENT)   private readonly redis:         Redis,
    @Inject(DB_TOKEN)       private readonly db:            NodePgDatabase<typeof schema>,
    private readonly config:        ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const conn     = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

    this.worker = new Worker<BotDlqPayload>(
      BOT_DLQ,
      (job) => this.handleDeadLetter(job),
      {
        connection:  conn as any,
        concurrency: 2,
        lockDuration: 60_000,
      },
    );

    this.worker.on('error',     (err)      => this.logger.error(`[DLQ Worker] Error: ${err.message}`));
    this.worker.on('completed', (job)      => this.logger.warn(`[DLQ Worker] Acknowledged: ${job.id}`));
    this.worker.on('failed',    (job, err) =>
      this.logger.error(`[DLQ Worker] Self-failure on job ${job?.id}: ${err.message}`)
    );

    this.logger.log('[DLQ Worker] Online — concurrency=2');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORE HANDLER
  // ══════════════════════════════════════════════════════════════════════════

  private async handleDeadLetter(job: Job<BotDlqPayload>): Promise<void> {
    const { original_payload, failure_reason, final_attempt, last_error, failed_at } = job.data;

    this.logger.error(
      `[DLQ] Dead-letter received — bot=${original_payload.bot_id} ` +
      `tenant=${original_payload.tenant_id} attempts=${final_attempt} ` +
      `reason=${failure_reason}`,
    );

    // ── 1. Structured log (always fires first — never silenced) ──────────────
    // Captured by your log aggregator (Datadog, CloudWatch, etc.)
    this.logger.error(JSON.stringify({
      event:         'dlq.bot_execution',
      bot_id:        original_payload.bot_id,
      tenant_id:     original_payload.tenant_id,
      engine:        original_payload.engine_version,
      execution_type: original_payload.execution_type,
      attempts:      final_attempt,
      reason:        failure_reason,
      error:         last_error,
      failed_at:     new Date(failed_at).toISOString(),
    }));

    // ── 2. Persist permanent audit record ────────────────────────────────────
    await this.persistAuditRecord(job.data);

    // ── 3. Increment consecutive failure counter ─────────────────────────────
    const consecutiveKey = `dlq:consecutive:${original_payload.bot_id}`;
    const consecutive    = await this.redis.incr(consecutiveKey);
    await this.redis.expire(consecutiveKey, 24 * 3600);  // reset daily

    // ── 4. Auto-suspend if bot is serially failing ───────────────────────────
    if (consecutive >= AUTO_SUSPEND_THRESHOLD) {
      await this.suspendBot(original_payload.bot_id, original_payload.tenant_id, consecutive);
    }

    // ── 5. Send alert (failure does NOT rethrow — DLQ job is always acked) ──
    try {
      await this.notifications.sendCritical({
        title:   `⚠️ Bot DLQ — ${original_payload.bot_id}`,
        message: `Bot execution failed after ${final_attempt} attempts.\n` +
                 `Tenant: ${original_payload.tenant_id}\n` +
                 `Engine: ${original_payload.engine_version}\n` +
                 `Reason: ${failure_reason}\n` +
                 `Error: ${last_error}`,
      });
    } catch (alertErr) {
      // Alert failure must NEVER prevent job acknowledgement
      this.logger.error(`[DLQ] Alert failed (non-fatal): ${(alertErr as Error).message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ══════════════════════════════════════════════════════════════════════════

  private async persistAuditRecord(payload: BotDlqPayload): Promise<void> {
    try {
      await this.db.insert(schema.dlqEvents).values({
        orderId:       payload.original_payload.bot_id ?? 'bot-dlq',
        userId:        ((payload as unknown as {original_payload?: {user_id?: string}}).original_payload?.user_id) ?? null,
        failureReason: payload.failure_reason,
        attemptsMade:  payload.final_attempt ?? 0,
      }).onConflictDoNothing();
    } catch (err) {
      this.logger.error(`[DLQ] Audit persist failed: ${(err as Error).message}`);
    }
  }

  private async suspendBot(
    botId: string,
    tenantId: string,
    consecutive: number,
  ): Promise<void> {
    try {
      await this.db
        .update(schema.bots)
        .set({
          isActive:        false,
          suspendedReason: `Auto-suspended after ${consecutive} consecutive DLQ failures`,
          // suspendedAt:     new Date(),
        })
        .where(eq(schema.bots.id, botId));

      this.logger.error(
        `[DLQ] Bot ${botId} (tenant=${tenantId}) AUTO-SUSPENDED after ${consecutive} failures`,
      );
    } catch (err) {
      this.logger.error(`[DLQ] Failed to suspend bot ${botId}: ${(err as Error).message}`);
    }
  }
}
