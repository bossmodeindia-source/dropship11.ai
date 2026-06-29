/**
 * AiJobService
 *
 * Helper for the async AI job pattern:
 *  1. Controller calls createJob() → inserts pending row, enqueues BullMQ job
 *  2. Returns jobId to client immediately (HTTP 202)
 *  3. Processor resolves result, updates row to done/failed
 *  4. Client polls getJob(jobId) → returns result when ready
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import {
  AI_CRITICAL_QUEUE,
  AI_STANDARD_QUEUE,
  AI_BACKGROUND_QUEUE,
  JOB_STATUS_PENDING,
  JobStatus,
} from './queue.constants';

export type QueueName = 'critical' | 'standard' | 'background';

export interface CreateJobInput {
  userId:        string;
  queue:         QueueName;
  jobName:       string;
  operation:     string;
  context:       Record<string, unknown>;
  productScore?: number;
  userTier?:     string;
}

export interface JobResult {
  jobId:       string;
  queue:       string;
  operation:   string;
  status:      JobStatus;
  result?:     unknown;
  error?:      string;
  createdAt:   Date;
  completedAt?: Date;
}

@Injectable()
export class AiJobService {
  private readonly logger = new Logger(AiJobService.name);

  constructor(
    @Inject(DB_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    @InjectQueue(AI_CRITICAL_QUEUE)
    private readonly criticalQueue: Queue,
    @InjectQueue(AI_STANDARD_QUEUE)
    private readonly standardQueue: Queue,
    @InjectQueue(AI_BACKGROUND_QUEUE)
    private readonly backgroundQueue: Queue,
  ) {}

  async createJob(input: CreateJobInput): Promise<{ jobId: string }> {
    const jobId = uuidv4();

    // 1. Persist job record (pending)
    await this.db.insert(schema.aiJobResults).values({
      jobId,
      queue:     input.queue,
      operation: input.operation,
      userId:    input.userId,
      status:    JOB_STATUS_PENDING,
    });

    // 2. Enqueue with appropriate queue
    const payload = {
      jobId,
      userId:       input.userId,
      operation:    input.operation,
      context:      input.context,
      productScore: input.productScore,
      userTier:     input.userTier,
    };

    const queueRef = this.resolveQueue(input.queue);
    await queueRef.add(input.jobName, payload, {
      attempts: input.queue === 'critical' ? 5 : 3,
      backoff:  {
        type:  'exponential',
        delay: input.queue === 'critical' ? 500 : 1_000,
      },
    });

    this.logger.debug(
      `[AiJob] Created ${input.operation} job ${jobId} on queue ${input.queue}`,
    );

    return { jobId };
  }

  async getJob(jobId: string): Promise<JobResult | null> {
    const row = await this.db.query.aiJobResults.findFirst({
      where: eq(schema.aiJobResults.jobId, jobId),
    });

    if (!row) return null;

    return {
      jobId:       row.jobId,
      queue:       row.queue,
      operation:   row.operation,
      status:      row.status as JobStatus,
      result:      row.result,
      error:       row.error ?? undefined,
      createdAt:   row.createdAt,
      completedAt: row.completedAt ?? undefined,
    };
  }

  private resolveQueue(name: QueueName): Queue {
    switch (name) {
      case 'critical':   return this.criticalQueue;
      case 'standard':   return this.standardQueue;
      case 'background': return this.backgroundQueue;
    }
  }
}
