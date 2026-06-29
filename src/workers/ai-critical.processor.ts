/**
 * AiCriticalProcessor — V66 BullMQ (migrated from @nestjs/bull)
 *
 * V66 CHANGES:
 *   ✅ @Processor / @Process from @nestjs/bullmq
 *   ✅ Job type from bullmq
 *   ✅ QueueIdempotencyService applied (prevents duplicate execution)
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Inject }        from '@nestjs/common';
import { Job }                   from 'bullmq';
import { NodePgDatabase }        from 'drizzle-orm/node-postgres';
import { eq }                    from 'drizzle-orm';
import { DB_TOKEN }              from '../common/database/database.module';
import * as schema               from '../common/database/schema';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { QueueIdempotencyService } from '../common/queue/queue-idempotency.service';
import {
  AI_CRITICAL_QUEUE,
  JOB_SCORING_EVALUATE,
  JOB_STATUS_PROCESSING,
  JOB_STATUS_DONE,
  JOB_STATUS_FAILED,
} from './queue.constants';

export interface ScoringJobPayload {
  jobId:     string;
  userId:    string;
  operation: 'scoring';
  context:   Record<string, unknown>;
  userTier?: 'free' | 'starter' | 'pro' | 'enterprise';
}

@Processor(AI_CRITICAL_QUEUE)
export class AiCriticalProcessor extends WorkerHost {
  private readonly logger = new Logger(AiCriticalProcessor.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly orchestrator: AiOrchestratorService,
    private readonly idempotency: QueueIdempotencyService,
  ) {
    super();
  }

  async process(job: Job<ScoringJobPayload>): Promise<void> {
    const { jobId, userId, operation, context, userTier } = job.data;
    this.logger.debug(`[Critical] Processing ${operation} job ${jobId} (attempt ${job.attemptsMade + 1})`);

    // V66: Idempotency guard — prevents duplicate execution on retry/crash
    const { skipped } = await this.idempotency.guardExecution(
      job.name,
      job.id!,
      async () => {
        await this.markProcessing(jobId);

        try {
          const result = await this.orchestrator.resolve({
            userId,
            operation,
            context,
            userTier: userTier ?? 'free',
          });

          await this.markDone(jobId, result.content);
          this.logger.debug(`[Critical] Job ${jobId} completed via ${result.source}`);
        } catch (err) {
          this.logger.error(`[Critical] Job ${jobId} failed: ${(err as Error).message}`);
          await this.markFailed(jobId, (err as Error).message);
          throw err; // BullMQ applies retry policy
        }
      },
    );

    if (skipped) {
      this.logger.debug(`[Critical] Skipping duplicate job ${job.name}:${job.id}`);
    }
  }

  private async markProcessing(jobId: string): Promise<void> {
    await this.db
      .update(schema.aiJobResults)
      .set({ status: JOB_STATUS_PROCESSING })
      .where(eq(schema.aiJobResults.jobId, jobId));
  }

  private async markDone(jobId: string, result: unknown): Promise<void> {
    await this.db
      .update(schema.aiJobResults)
      .set({ status: JOB_STATUS_DONE, result: result as Record<string, unknown>, completedAt: new Date() })
      .where(eq(schema.aiJobResults.jobId, jobId));
  }

  private async markFailed(jobId: string, error: string): Promise<void> {
    await this.db
      .update(schema.aiJobResults)
      .set({ status: JOB_STATUS_FAILED, error, completedAt: new Date() })
      .where(eq(schema.aiJobResults.jobId, jobId));
  }
}
