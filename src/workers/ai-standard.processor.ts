/**
 * AiStandardProcessor
 *
 * Handles the ai:standard queue — listing generation, campaign copy,
 * hooks, and captions. These are the most common AI operations.
 *
 * Concurrency: 5 workers
 * Max attempts: 3
 * Backoff: 1s exponential
 *
 * HTTP pattern: caller receives { jobId } immediately (HTTP 202),
 * then polls GET /ai/jobs/:jobId for the result.
 */

import { Processor, WorkerHost } from "@nestjs/bullmq";;
import { Logger, Inject } from '@nestjs/common';
import { Job } from "bullmq";;
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import {
  AI_STANDARD_QUEUE,
  JOB_LISTING_GENERATE,
  JOB_CAMPAIGN_GENERATE,
  JOB_HOOKS_GENERATE,
  JOB_CAPTIONS_GENERATE,
  JOB_STATUS_PROCESSING,
  JOB_STATUS_DONE,
  JOB_STATUS_FAILED,
} from './queue.constants';

export interface StandardJobPayload {
  jobId:         string;
  userId:        string;
  operation:     'listing' | 'campaign' | 'hooks' | 'captions';
  context:       Record<string, unknown>;
  productScore?: number;
  userTier?:     'free' | 'starter' | 'pro' | 'enterprise';
}

@Processor(AI_STANDARD_QUEUE)
export class AiStandardProcessor {
  private readonly logger = new Logger(AiStandardProcessor.name);

  constructor(
    @Inject(DB_TOKEN)              private readonly db:           NodePgDatabase<typeof schema>,
    private readonly orchestrator: AiOrchestratorService,
  ) {}

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleListing(job: Job<StandardJobPayload>): Promise<void> {
    return this.process(job);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleCampaign(job: Job<StandardJobPayload>): Promise<void> {
    return this.process(job);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleHooks(job: Job<StandardJobPayload>): Promise<void> {
    return this.process(job);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleCaptions(job: Job<StandardJobPayload>): Promise<void> {
    return this.process(job);
  }

  // ── Core processor ─────────────────────────────────────────────────────────

  private async process(job: Job<StandardJobPayload>): Promise<void> {
    const { jobId, userId, operation, context, productScore, userTier } = job.data;
    this.logger.debug(`[Standard] Processing ${operation} job ${jobId}`);

    await this.updateStatus(jobId, JOB_STATUS_PROCESSING);

    try {
      const result = await this.orchestrator.resolve({
        userId,
        operation,
        context,
        productScore: productScore ?? 0,
        userTier:     userTier     ?? 'free',
      });

      await this.db
        .update(schema.aiJobResults)
        .set({
          status:      JOB_STATUS_DONE,
          result:      result.content as Record<string, unknown>,
          completedAt: new Date(),
        })
        .where(eq(schema.aiJobResults.jobId, jobId));

      this.logger.debug(
        `[Standard] Job ${jobId} done via ${result.source} in ${result.latencyMs}ms`,
      );
    } catch (err) {
      this.logger.error(`[Standard] Job ${jobId} failed: ${(err as Error).message}`);
      await this.db
        .update(schema.aiJobResults)
        .set({
          status:      JOB_STATUS_FAILED,
          error:       (err as Error).message,
          completedAt: new Date(),
        })
        .where(eq(schema.aiJobResults.jobId, jobId));
      throw err;
    }
  }

  private async updateStatus(jobId: string, status: string): Promise<void> {
    await this.db
      .update(schema.aiJobResults)
      .set({ status })
      .where(eq(schema.aiJobResults.jobId, jobId));
  }
}
