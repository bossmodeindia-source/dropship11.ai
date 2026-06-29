/**
 * BotQueueConfig
 *
 * Creates and exports BullMQ Queue instances for the bot execution tier.
 *
 * Design notes:
 *  - Each Queue uses a DEDICATED ioredis connection (BullMQ requirement: one
 *    blocking connection per queue client — never share with app logic).
 *  - All queues are created lazily via the factory so the Redis URL can be
 *    resolved at startup from ConfigService without a circular dep.
 *  - QueueEvents are registered per-queue for job lifecycle monitoring.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import {
  BOT_DLQ,
  BOT_EXECUTION_QUEUE,
  BOT_PRIORITY_QUEUE,
  BOT_RETRY_QUEUE,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  JOB_TIMEOUT_MS,
} from './bot-queue.constants';

// Canonical injection tokens — use these everywhere instead of string literals.
export const BOT_EXECUTION_QUEUE_TOKEN = 'BOT_EXECUTION_QUEUE';
export const BOT_PRIORITY_QUEUE_TOKEN  = 'BOT_PRIORITY_QUEUE';
export const BOT_RETRY_QUEUE_TOKEN     = 'BOT_RETRY_QUEUE';
export const BOT_DLQ_TOKEN             = 'BOT_DLQ';

/** Shared default job options applied to every enqueued job. */
const sharedJobOptions = {
  removeOnComplete: { count: 500 },
  removeOnFail:     { count: 200 },
  timeout: JOB_TIMEOUT_MS,
};

@Injectable()
export class BotQueueConfig implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotQueueConfig.name);

  // Public queue handles — injected into services via module providers
  executionQueue!: Queue;
  priorityQueue!:  Queue;
  retryQueue!:     Queue;
  dlqQueue!:       Queue;

  // QueueEvents for lifecycle monitoring (metrics, alerts)
  executionEvents!: QueueEvents;
  priorityEvents!:  QueueEvents;

  // Dedicated Redis connections (BullMQ requires separate blocking connections)
  private connections: Redis[] = [];

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const redisUrl  = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const redisOpts = this.parseRedisUrl(redisUrl);

    // ── Execution queue ──────────────────────────────────────────────────────
    this.executionQueue = new Queue(BOT_EXECUTION_QUEUE, {
      connection: this.newConn(redisOpts) as any,
      defaultJobOptions: {
        ...sharedJobOptions,
        attempts: MAX_RETRY_ATTEMPTS,
        backoff:  { type: 'exponential', delay: RETRY_BASE_DELAY_MS },
      },
    });

    // ── Priority queue (paid tiers) ──────────────────────────────────────────
    this.priorityQueue = new Queue(BOT_PRIORITY_QUEUE, {
      connection: this.newConn(redisOpts) as any,
      defaultJobOptions: {
        ...sharedJobOptions,
        attempts: MAX_RETRY_ATTEMPTS,
        backoff:  { type: 'exponential', delay: RETRY_BASE_DELAY_MS },
        // Priority is set per-job at enqueue time (PRIORITY_HIGH / PRIORITY_NORMAL)
      },
    });

    // ── Retry queue (soft-failure backpressure) ──────────────────────────────
    this.retryQueue = new Queue(BOT_RETRY_QUEUE, {
      connection: this.newConn(redisOpts) as any,
      defaultJobOptions: {
        ...sharedJobOptions,
        attempts: 3,
        backoff:  { type: 'exponential', delay: RETRY_BASE_DELAY_MS * 3 },
      },
    });

    // ── Dead-letter queue ────────────────────────────────────────────────────
    this.dlqQueue = new Queue(BOT_DLQ, {
      connection: this.newConn(redisOpts) as any,
      defaultJobOptions: {
        removeOnComplete: false,  // DLQ jobs are never auto-removed
        removeOnFail:     false,
        attempts: 1,              // DLQ jobs never re-attempt; human intervention
      },
    });

    // ── QueueEvents (monitoring) ─────────────────────────────────────────────
    this.executionEvents = new QueueEvents(BOT_EXECUTION_QUEUE, {
      connection: this.newConn(redisOpts) as any,
    });
    this.priorityEvents = new QueueEvents(BOT_PRIORITY_QUEUE, {
      connection: this.newConn(redisOpts) as any,
    });

    this.logger.log('[BotQueueConfig] All queues initialised');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.executionQueue?.close(),
      this.priorityQueue?.close(),
      this.retryQueue?.close(),
      this.dlqQueue?.close(),
      this.executionEvents?.close(),
      this.priorityEvents?.close(),
      ...this.connections.map((c) => c.quit()),
    ]);
    this.logger.log('[BotQueueConfig] All queues and connections closed');
  }

  /** Snapshot of queue depths for monitoring/backpressure decisions. */
  async getQueueMetrics() {
    const [execWaiting, execActive, prioWaiting, prioActive, retryWaiting, dlqCount] =
      await Promise.all([
        this.executionQueue.getWaitingCount(),
        this.executionQueue.getActiveCount(),
        this.priorityQueue.getWaitingCount(),
        this.priorityQueue.getActiveCount(),
        this.retryQueue.getWaitingCount(),
        this.dlqQueue.getWaitingCount(),
      ]);

    return {
      execution: { waiting: execWaiting, active: execActive },
      priority:  { waiting: prioWaiting, active: prioActive },
      retry:     { waiting: retryWaiting },
      dlq:       { count: dlqCount },
      totalActive: execActive + prioActive,
      totalWaiting: execWaiting + prioWaiting + retryWaiting,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private newConn(opts: { host: string; port: number; password?: string; db?: number }): Redis {
    const conn = new Redis({
      ...opts,
      maxRetriesPerRequest: null,  // required by BullMQ
      enableReadyCheck: false,
      lazyConnect: false,
    });
    conn.on('error', (err) => this.logger.error(`[Redis] Connection error: ${err.message}`));
    this.connections.push(conn);
    return conn;
  }

  private parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
    try {
      const u = new URL(url);
      return {
        host:     u.hostname || 'localhost',
        port:     parseInt(u.port || '6379', 10),
        password: u.password || undefined,
        db:       u.pathname ? parseInt(u.pathname.slice(1) || '0', 10) : 0,
      };
    } catch {
      return { host: 'localhost', port: 6379 };
    }
  }
}
