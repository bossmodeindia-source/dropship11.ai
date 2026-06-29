/**
 * BotExecutionWorker
 *
 * Stateless BullMQ worker that processes jobs from bot_execution_queue
 * and priority_queue. One worker class handles both queues; separate
 * instances are started with different queue names.
 *
 * Execution pipeline per job:
 *   1. Deserialise + validate job payload
 *   2. Fetch bot state from DB (+ Redis cache)
 *   3. Call AI Engine (version-dispatched)
 *   4. Store result to DB
 *   5. Update Redis cache
 *   6. Release global concurrency slot
 *   7. Emit metrics
 *
 * Failure handling:
 *   - Retryable errors  → rethrow (BullMQ applies exponential backoff)
 *   - Terminal errors   → catch + route to RetryService for DLQ decision
 *   - Timeout           → enforced by BullMQ `timeout` job option
 *
 * Horizontal scaling:
 *   Run `node dist/worker.js --queue bot_execution_queue --concurrency 40`
 *   across as many processes/containers as needed. Each independently
 *   negotiates work from Redis — no shared state between workers.
 */

import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject,
} from '@nestjs/common';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';

import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { DB_TOKEN } from '../../common/database/database.module';
import * as schema from '../../common/database/schema';

import { TenantRateLimiterService } from '../rate-limiter/tenant-rate-limiter.service';
import { BotRetryService } from '../retry/bot-retry.service';
import { BotJobPayload, BotExecutionResult } from '../orchestrator/bot-job.types';
import {
  BOT_EXECUTION_QUEUE,
  BOT_PRIORITY_QUEUE,
  WORKER_CONCURRENCY_EXECUTION,
  WORKER_CONCURRENCY_PRIORITY,
  MAX_RETRY_ATTEMPTS,
} from '../queues/bot-queue.constants';

// ── AI engine dispatch — import actual engine services here ──────────────────
// Each version is a NestJS service; we use a simple map dispatched by version
// string. Add new versions without changing worker logic.
import { AiEngineDispatcher } from '../engine/ai-engine.dispatcher';

/** Cache TTL for bot state in Redis (seconds) */
const BOT_STATE_CACHE_TTL = 300;

@Injectable()
export class BotExecutionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotExecutionWorker.name);

  private executionWorker!: Worker<BotJobPayload>;
  private priorityWorker!:  Worker<BotJobPayload>;

  constructor(
    @Inject(REDIS_CLIENT)   private readonly redis:       Redis,
    @Inject(DB_TOKEN)       private readonly db:          NodePgDatabase<typeof schema>,
    private readonly config:        ConfigService,
    private readonly rateLimiter:   TenantRateLimiterService,
    private readonly retryService:  BotRetryService,
    private readonly aiDispatcher:  AiEngineDispatcher,
  ) {}

  onModuleInit(): void {
    const redisUrl  = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = this.newRedisConn(redisUrl);

    // ── Execution queue worker ───────────────────────────────────────────────
    this.executionWorker = new Worker<BotJobPayload>(
      BOT_EXECUTION_QUEUE,
      (job) => this.process(job),
      {
        connection:  connection.duplicate() as any,
        concurrency: WORKER_CONCURRENCY_EXECUTION,
        lockDuration: 120_000,    // matches job timeout
        stalledInterval: 30_000,
        maxStalledCount: 2,
      },
    );

    // ── Priority queue worker ────────────────────────────────────────────────
    this.priorityWorker = new Worker<BotJobPayload>(
      BOT_PRIORITY_QUEUE,
      (job) => this.process(job),
      {
        connection:  connection.duplicate() as any,
        concurrency: WORKER_CONCURRENCY_PRIORITY,
        lockDuration: 120_000,
        stalledInterval: 15_000,
        maxStalledCount: 2,
      },
    );

    this.attachWorkerEvents(this.executionWorker,  'exec');
    this.attachWorkerEvents(this.priorityWorker,   'prio');

    this.logger.log(
      `[Worker] Bot execution workers online — ` +
      `execution concurrency=${WORKER_CONCURRENCY_EXECUTION}, ` +
      `priority concurrency=${WORKER_CONCURRENCY_PRIORITY}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.executionWorker?.close(),
      this.priorityWorker?.close(),
    ]);
    this.logger.log('[Worker] Workers closed');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORE PROCESSOR
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Process a single bot execution job.
   * This method must be STATELESS — all state flows through the job payload,
   * DB, and Redis. Never store cross-job state in class fields.
   */
  private async process(job: Job<BotJobPayload>): Promise<BotExecutionResult> {
    const payload   = job.data;
    const startedAt = Date.now();

    this.logger.debug(
      `[Worker] Processing job=${job.id} bot=${payload.bot_id} ` +
      `tenant=${payload.tenant_id} engine=${payload.engine_version} ` +
      `attempt=${payload.attempt_number}`,
    );

    // ── Mark job as processing in DB ─────────────────────────────────────────
    await this.updateJobStatus(job.id!, 'processing');

    try {
      // ── Step 1: Fetch bot state ─────────────────────────────────────────────
      const botState = await this.fetchBotState(payload.bot_id, payload.tenant_id);
      if (!botState) {
        // Bot was deleted — discard job, do not retry
        throw new UnrecoverableError(`Bot ${payload.bot_id} not found — discarding`);
      }

      // ── Step 2: Execute AI engine ───────────────────────────────────────────
      const engineOutput = await this.aiDispatcher.dispatch({
        engineVersion: payload.engine_version,
        botState,
        executionType: payload.execution_type,
        tenantId:      payload.tenant_id,
      });

      // ── Step 3: Store results ───────────────────────────────────────────────
      const durationMs = Date.now() - startedAt;
      const result: BotExecutionResult = {
        bot_id:        payload.bot_id,
        tenant_id:     payload.tenant_id,
        job_id:        job.id!,
        status:        'success',
        engine_output: engineOutput as unknown as Record<string,unknown>,
        duration_ms:   durationMs,
        completed_at:  Date.now(),
      };

      await this.storeResult(result);
      await this.updateBotState(payload.bot_id, engineOutput as unknown as Record<string,unknown>);
      await this.updateJobStatus(job.id!, 'completed');

      this.logger.log(
        `[Worker] Job ${job.id} completed — bot=${payload.bot_id} ` +
        `duration=${durationMs}ms`,
      );

      return result;
    } catch (err) {
      const error       = err as Error;
      const isTerminal  = err instanceof UnrecoverableError;
      const durationMs  = Date.now() - startedAt;

      this.logger.error(
        `[Worker] Job ${job.id} failed — bot=${payload.bot_id} ` +
        `attempt=${payload.attempt_number}/${MAX_RETRY_ATTEMPTS} ` +
        `terminal=${isTerminal} error=${error.message}`,
      );

      await this.updateJobStatus(job.id!, 'failed', error.message);

      if (isTerminal || payload.attempt_number >= MAX_RETRY_ATTEMPTS) {
        // Exhausted all retries — send to DLQ (do not rethrow)
        await this.retryService.handleExhausted(payload, error.message);
        const result: BotExecutionResult = {
          bot_id:        payload.bot_id,
          tenant_id:     payload.tenant_id,
          job_id:        job.id!,
          status:        'failed',
          engine_output: {},
          duration_ms:   durationMs,
          completed_at:  Date.now(),
          error:         error.message,
        };
        await this.storeResult(result);
        return result;
      }

      // Retryable — rethrow so BullMQ can schedule next attempt
      throw err;
    } finally {
      // ALWAYS release the global concurrency slot
      await this.rateLimiter.releaseSlot();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE — DB + CACHE HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private async fetchBotState(
    botId: string,
    tenantId: string,
  ): Promise<Record<string, unknown> | null> {
    // 1. Try Redis cache first
    const cacheKey = `bot:state:${botId}`;
    const cached   = await this.redis.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch { /* fall through to DB */ }
    }

    // 2. Fetch from DB
    try {
      const rows = await this.db
        .select()
        .from(schema.bots)
        .where(eq(schema.bots.id, botId))
        .limit(1);

      if (!rows.length) return null;

      const state = rows[0] as Record<string, unknown>;
      // Cache for 5 minutes
      await this.redis.setex(cacheKey, BOT_STATE_CACHE_TTL, JSON.stringify(state));
      return state;
    } catch (err) {
      this.logger.error(`[Worker] fetchBotState failed for ${botId}: ${(err as Error).message}`);
      throw err;  // Propagate — worker will retry
    }
  }

  private async updateBotState(
    botId: string,
    engineOutput: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db
        .update(schema.bots)
        .set({
          lastExecutedAt: new Date(),
          lastOutput:     engineOutput,
        })
        .where(eq(schema.bots.id, botId));

      // Invalidate cache so next fetch gets fresh state
      await this.redis.del(`bot:state:${botId}`);
    } catch (err) {
      // Non-fatal — log and continue
      this.logger.warn(`[Worker] updateBotState failed for ${botId}: ${(err as Error).message}`);
    }
  }

  private async storeResult(result: BotExecutionResult): Promise<void> {
    try {
      await this.db.insert(schema.botExecutionResults).values({
        jobRecordId: result.job_id,            // Bull job ID stored as jobRecordId
        botId:       result.bot_id,
        decision:    result.status,            // map execution status → decision field
        payload:     result.engine_output as Record<string,unknown> ?? {},
        executedAt:  new Date(result.completed_at),
      });
    } catch (err) {
      this.logger.error(`[Worker] storeResult failed for job ${result.job_id}: ${(err as Error).message}`);
    }
  }

  private async updateJobStatus(
    jobId: string,
    status: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.db
        .update(schema.botJobRecords)
        .set({ status, errorMsg: error ?? null, updatedAt: new Date() })
        .where(eq(schema.botJobRecords.jobId, jobId));
    } catch { /* non-fatal */ }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE — WORKER EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════════════

  private attachWorkerEvents(worker: Worker, tag: string): void {
    worker.on('error',   (err)        => this.logger.error(`[Worker:${tag}] Error: ${err.message}`));
    worker.on('stalled', (jobId)      => this.logger.warn(`[Worker:${tag}] Stalled: ${jobId}`));
    worker.on('failed',  (job, err)   => {
      if (job) {
        this.logger.warn(
          `[Worker:${tag}] Failed: job=${job.id} attempt=${job.attemptsMade} err=${err.message}`,
        );
      }
    });
  }

  private newRedisConn(url: string): Redis {
    const conn = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    conn.on('error', (e) => this.logger.error(`[Worker Redis] ${e.message}`));
    return conn;
  }
}
