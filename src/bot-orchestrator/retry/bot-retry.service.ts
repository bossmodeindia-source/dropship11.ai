/**
 * BotRetryService
 *
 * Manages the full retry lifecycle for failed bot executions:
 *
 *   handleExhausted()  — called by BotExecutionWorker when attempts run out
 *                        → routes to DLQ via BotJobDispatcher
 *
 *   BotRetryWorker     — inner class that processes the retry_queue
 *                        → re-dispatches jobs to execution/priority queues
 *
 * The retry_queue is separate from the main execution queues so that
 * retry traffic can be throttled independently without impacting new job
 * throughput.
 *
 * Backoff strategy: exponential with jitter
 *   attempt 1 → ~2s, attempt 2 → ~4s, attempt 3 → ~8s ...
 *   Jitter is ±20% to avoid thundering herd on mass failures.
 */

import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef,
} from '@nestjs/common';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { BotJobPayload } from '../orchestrator/bot-job.types';
import {
  BOT_RETRY_QUEUE,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  WORKER_CONCURRENCY_RETRY,
} from '../queues/bot-queue.constants';

// Forward ref to avoid circular dep between Orchestrator ↔ Retry
import { BotJobDispatcher } from '../orchestrator/bot-job-dispatcher.service';

@Injectable()
export class BotRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotRetryService.name);
  private retryWorker!: Worker<BotJobPayload>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => BotJobDispatcher))
    private readonly orchestrator: BotJobDispatcher,
  ) {}

  onModuleInit(): void {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const conn     = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

    this.retryWorker = new Worker<BotJobPayload>(
      BOT_RETRY_QUEUE,
      (job) => this.processRetry(job),
      {
        connection:  conn as any,
        concurrency: WORKER_CONCURRENCY_RETRY,
        lockDuration: 120_000,
      },
    );

    this.retryWorker.on('error',   (err)       => this.logger.error(`[Retry Worker] ${err.message}`));
    this.retryWorker.on('stalled', (jobId)     => this.logger.warn(`[Retry Worker] Stalled: ${jobId}`));

    this.logger.log(`[Retry Worker] Online — concurrency=${WORKER_CONCURRENCY_RETRY}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.retryWorker?.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — called by BotExecutionWorker
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Called when a job has exhausted all BullMQ-level retry attempts.
   * Decides whether to send to DLQ based on error type.
   */
  async handleExhausted(payload: BotJobPayload, lastError: string): Promise<void> {
    const reason = this.classifyFailure(lastError);

    this.logger.error(
      `[RetryService] Exhausted — bot=${payload.bot_id} ` +
      `tenant=${payload.tenant_id} reason=${reason}`,
    );

    await this.orchestrator.sendToDlq(payload, reason, lastError);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RETRY QUEUE PROCESSOR
  // ══════════════════════════════════════════════════════════════════════════

  private async processRetry(job: Job<BotJobPayload>): Promise<void> {
    const payload = job.data;

    this.logger.debug(
      `[Retry Worker] Processing retry — bot=${payload.bot_id} ` +
      `attempt=${payload.attempt_number}/${MAX_RETRY_ATTEMPTS}`,
    );

    if (payload.attempt_number > MAX_RETRY_ATTEMPTS) {
      // Should not happen — guard against misconfigured re-enqueue
      throw new UnrecoverableError(
        `Attempt ${payload.attempt_number} exceeds max ${MAX_RETRY_ATTEMPTS}`,
      );
    }

    // Re-enqueue to main execution queue with incremented attempt number.
    // The orchestrator re-validates subscription and checks backpressure.
    const newJobId = await this.orchestrator.reEnqueueForRetry(
      payload,
      payload.attempt_number + 1,
      job.id!,
    );

    if (!newJobId) {
      throw new Error(`Failed to re-enqueue bot ${payload.bot_id} for retry`);
    }

    this.logger.log(
      `[Retry Worker] Re-enqueued — bot=${payload.bot_id} ` +
      `newJobId=${newJobId} attempt=${payload.attempt_number + 1}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Classify the failure reason for DLQ categorisation and ops dashboards.
   */
  private classifyFailure(error: string): string {
    const lower = error.toLowerCase();

    if (lower.includes('not found') || lower.includes('deleted'))
      return 'bot_not_found';
    if (lower.includes('subscription') || lower.includes('unauthorized'))
      return 'subscription_invalid';
    if (lower.includes('timeout') || lower.includes('timed out'))
      return 'execution_timeout';
    if (lower.includes('rate limit') || lower.includes('429'))
      return 'upstream_rate_limit';
    if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('socket'))
      return 'network_error';
    if (lower.includes('out of memory') || lower.includes('heap'))
      return 'resource_exhaustion';

    return 'unknown_error';
  }

  /**
   * Exponential backoff with ±20% jitter.
   * Prevents thundering herd when many bots fail simultaneously.
   */
  static computeDelay(attempt: number): number {
    const base  = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);  // ±20%
    return Math.min(Math.round(base + jitter), 60_000);    // cap at 60s
  }
}
