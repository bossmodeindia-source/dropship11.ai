/**
 * FeedbackSchedulerService
 *
 * Registers all repeatable BullMQ jobs on application startup.
 * Runs once per process — BullMQ deduplicates by repeat key.
 *
 * Jobs registered:
 *  feedback:harvest — every 60 minutes
 *  cache:evict      — every 6 hours
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AI_BACKGROUND_QUEUE,
  JOB_MEMORY_HARVEST,
  JOB_CACHE_EVICT,
} from './queue.constants';

@Injectable()
export class FeedbackSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(FeedbackSchedulerService.name);

  constructor(
    @InjectQueue(AI_BACKGROUND_QUEUE) private readonly backgroundQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registerFeedbackHarvest();
    await this.registerCacheEviction();
  }

  private async registerFeedbackHarvest(): Promise<void> {
    try {
      await this.backgroundQueue.add(
        JOB_MEMORY_HARVEST,
        {},
        {
          repeat:   { every: 60 * 60 * 1000 },  // every 60 minutes
          attempts: 3,
          backoff:  { type: 'exponential', delay: 5_000 },
          jobId:    'feedback:harvest:repeatable', // stable ID prevents duplicates
        },
      );
      this.logger.log('[Scheduler] feedback:harvest registered (every 60 min)');
    } catch (err) {
      // Non-fatal — system still works without the feedback loop
      this.logger.warn(`[Scheduler] Failed to register feedback harvest: ${(err as Error).message}`);
    }
  }

  private async registerCacheEviction(): Promise<void> {
    try {
      await this.backgroundQueue.add(
        JOB_CACHE_EVICT,
        {},
        {
          repeat:   { every: 6 * 60 * 60 * 1000 }, // every 6 hours
          attempts: 1,
          jobId:    'cache:evict:repeatable',
        },
      );
      this.logger.log('[Scheduler] cache:evict registered (every 6h)');
    } catch (err) {
      this.logger.warn(`[Scheduler] Failed to register cache eviction: ${(err as Error).message}`);
    }
  }
}
