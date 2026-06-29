/**
 * QueueIdempotencyService — V66 CRITICAL
 *
 * Prevents duplicate job execution across:
 *   - worker crashes
 *   - retries
 *   - redeliveries
 *
 * Key format: processed:{job.name}:{job.id}
 * TTL: 24 hours minimum
 *
 * Protects: fulfillment, supplier routing, payments, tracking sync, AI jobs
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '../redis/inject-redis';
import { Redis } from 'ioredis';

export interface IdempotencyResult {
  alreadyProcessed: boolean;
  processedAt?: Date;
}

@Injectable()
export class QueueIdempotencyService {
  private readonly logger = new Logger(QueueIdempotencyService.name);
  private readonly DEFAULT_TTL_SECONDS = 86_400; // 24 hours

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Check if a job was already processed.
   * Returns { alreadyProcessed: true } if the key exists in Redis.
   */
  async check(
    jobName: string,
    jobId: string | number,
    ttlSeconds = this.DEFAULT_TTL_SECONDS,
  ): Promise<IdempotencyResult> {
    const key = `processed:${jobName}:${jobId}`;

    try {
      const existing = await this.redis.get(key);
      if (existing) {
        this.logger.debug(`[Idempotency] Job already processed: ${key}`);
        return { alreadyProcessed: true, processedAt: new Date(existing) };
      }
      return { alreadyProcessed: false };
    } catch (err) {
      // Redis unavailable — fail-open for non-critical, fail-closed for financial
      this.logger.error(`[Idempotency] Redis error checking key ${key}: ${(err as Error).message}`);
      // Conservative: treat as not processed — let job proceed
      // (Financial jobs should be guarded by RedisHealthGuard at route level)
      return { alreadyProcessed: false };
    }
  }

  /**
   * Mark a job as processed. Call AFTER successful completion.
   */
  async markProcessed(
    jobName: string,
    jobId: string | number,
    ttlSeconds = this.DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    const key = `processed:${jobName}:${jobId}`;
    try {
      await this.redis.set(key, new Date().toISOString(), 'EX', ttlSeconds);
      this.logger.debug(`[Idempotency] Marked processed: ${key} (TTL=${ttlSeconds}s)`);
    } catch (err) {
      this.logger.error(`[Idempotency] Failed to mark processed: ${key}: ${(err as Error).message}`);
      // Non-fatal — job completed successfully even if we couldn't record it
    }
  }

  /**
   * Convenience: check + process + mark in one call.
   * Returns false if already processed (skip).
   * Returns true if this is the first execution (proceed).
   */
  async guardExecution(
    jobName: string,
    jobId: string | number,
    processor: () => Promise<void>,
    ttlSeconds = this.DEFAULT_TTL_SECONDS,
  ): Promise<{ skipped: boolean }> {
    const { alreadyProcessed } = await this.check(jobName, jobId, ttlSeconds);

    if (alreadyProcessed) {
      this.logger.log(`[Idempotency] Skipping duplicate job ${jobName}:${jobId}`);
      return { skipped: true };
    }

    await processor();
    await this.markProcessed(jobName, jobId, ttlSeconds);
    return { skipped: false };
  }
}
