/**
 * AiBackgroundProcessor
 *
 * Handles the ai:background queue — media generation and cache maintenance.
 *
 * Concurrency: 2 workers (low priority, no SLA)
 * Max attempts: 2
 * Backoff: 5s exponential
 */

import { Processor, WorkerHost } from "@nestjs/bullmq";;
import { Logger, Inject } from '@nestjs/common';
import { Job } from "bullmq";;
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { SemanticCacheService } from '../ai-orchestrator/semantic-cache.service';
import {
  AI_BACKGROUND_QUEUE,
  JOB_MEDIA_GENERATE,
  JOB_CACHE_EVICT,
  JOB_STATUS_PROCESSING,
  JOB_STATUS_DONE,
  JOB_STATUS_FAILED,
} from './queue.constants';

export interface MediaJobPayload {
  jobId:     string;
  userId:    string;
  operation: 'media';
  context:   Record<string, unknown>;
  userTier?: 'free' | 'starter' | 'pro' | 'enterprise';
}

@Processor(AI_BACKGROUND_QUEUE)
export class AiBackgroundProcessor {
  private readonly logger = new Logger(AiBackgroundProcessor.name);

  constructor(
    @Inject(DB_TOKEN)              private readonly db:           NodePgDatabase<typeof schema>,
    private readonly orchestrator: AiOrchestratorService,
    private readonly cache:        SemanticCacheService,
  ) {}

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleMedia(job: Job<MediaJobPayload>): Promise<void> {
    const { jobId, userId, operation, context, userTier } = job.data;
    this.logger.debug(`[Background] Processing media job ${jobId}`);

    await this.updateStatus(jobId, JOB_STATUS_PROCESSING);

    try {
      const result = await this.orchestrator.resolve({
        userId,
        operation,
        context,
        userTier: userTier ?? 'free',
      });

      await this.db
        .update(schema.aiJobResults)
        .set({
          status:      JOB_STATUS_DONE,
          result:      result.content as Record<string, unknown>,
          completedAt: new Date(),
        })
        .where(eq(schema.aiJobResults.jobId, jobId));

      this.logger.debug(`[Background] Media job ${jobId} done via ${result.source}`);
    } catch (err) {
      this.logger.error(`[Background] Media job ${jobId} failed: ${(err as Error).message}`);
      await this.db
        .update(schema.aiJobResults)
        .set({ status: JOB_STATUS_FAILED, error: (err as Error).message, completedAt: new Date() })
        .where(eq(schema.aiJobResults.jobId, jobId));
      throw err;
    }
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleCacheEviction(_job: Job): Promise<void> {
    this.logger.debug('[Background] Running cache eviction');
    const evicted = await this.cache.evictExpired();
    this.logger.log(`[Background] Cache eviction complete — removed ${evicted} expired entries`);
  }

  private async updateStatus(jobId: string, status: string): Promise<void> {
    await this.db
      .update(schema.aiJobResults)
      .set({ status })
      .where(eq(schema.aiJobResults.jobId, jobId));
  }
}
