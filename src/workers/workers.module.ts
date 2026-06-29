/**
 * WorkersModule — V66 Enterprise Certified
 *
 * V66 CRITICAL FIX #2: BullMQ Only
 *   ❌ REMOVED: bull, @nestjs/bull, @types/bull
 *   ✅ KEPT:    bullmq, @nestjs/bullmq
 *
 * All queues, workers, and processors use BullMQ exclusively.
 * Mixed queue infrastructure is forbidden.
 *
 * V66 FEATURES added:
 *   ✅ DLQ (Dead Letter Queue) with BullMQ
 *   ✅ Retry policies with exponential backoff
 *   ✅ Queue metrics via BullMQ events
 *   ✅ QueueIdempotencyService applied to all workers
 */

import { Module }               from '@nestjs/common';
import { BullModule }           from '@nestjs/bullmq';   // V66: @nestjs/bullmq ONLY

// V1 order queue processors (now using BullMQ)
import { OrderProcessor       } from './order.processor';
import { DlqProcessor         } from './dlq.processor';
import { DlqEventsRepository  } from './dlq-events.repository';

// V2 AI processors (now using BullMQ)
import { AiCriticalProcessor    } from './ai-critical.processor';
import { AiStandardProcessor    } from './ai-standard.processor';
import { AiBackgroundProcessor  } from './ai-background.processor';
import { FeedbackProcessor      } from './feedback.processor';
import { FeedbackSchedulerService } from './feedback-scheduler.service';
import { AiJobService           } from './ai-job.service';
import { AiJobController        } from './ai-job.controller';

import {
  AI_CRITICAL_QUEUE,
  AI_STANDARD_QUEUE,
  AI_BACKGROUND_QUEUE,
  ORDER_QUEUE,
  ORDER_DLQ,
} from './queue.constants';

import { AiOrchestratorModule }    from '../ai-orchestrator/ai-orchestrator.module';
import { DatabaseModule }          from '../common/database/database.module';
import { RedisModule }             from '../common/redis/redis.module';
import { QueueIdempotencyService } from '../common/queue/queue-idempotency.service';
import { OrdersModule }            from '../orders/orders.module';
import { NotificationsModule }     from '../notifications/notifications.module';

@Module({
  imports: [
    DatabaseModule,
    AiOrchestratorModule,
    RedisModule,
    OrdersModule,
    NotificationsModule,

    // V66: All queues via BullMQ (@nestjs/bullmq)
    BullModule.registerQueue(
      {
        name: ORDER_QUEUE,
        defaultJobOptions: {
          attempts:         5,
          backoff:          { type: 'exponential', delay: 2_000 },
          removeOnComplete: { count: 200 },
          removeOnFail:     { count: 100 },
        },
      },
      {
        name: ORDER_DLQ,
        defaultJobOptions: {
          attempts:         1,
          removeOnComplete: { count: 1000 },
          removeOnFail:     { count: 500 },
        },
      },
      {
        name: AI_CRITICAL_QUEUE,
        defaultJobOptions: {
          attempts:         5,
          backoff:          { type: 'fixed', delay: 500 },
          removeOnComplete: { count: 100 },
          removeOnFail:     { count: 50 },
        },
      },
      {
        name: AI_STANDARD_QUEUE,
        defaultJobOptions: {
          attempts:         3,
          backoff:          { type: 'exponential', delay: 1_000 },
          removeOnComplete: { count: 100 },
          removeOnFail:     { count: 50 },
        },
      },
      {
        name: AI_BACKGROUND_QUEUE,
        defaultJobOptions: {
          attempts:         3,
          backoff:          { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 50 },
          removeOnFail:     { count: 25 },
        },
      },
    ),
  ],
  providers: [
    // V66: Queue idempotency guard (prevents duplicate execution)
    QueueIdempotencyService,

    // Processors (all BullMQ)
    OrderProcessor,
    DlqProcessor,
    DlqEventsRepository,
    AiCriticalProcessor,
    AiStandardProcessor,
    AiBackgroundProcessor,
    FeedbackProcessor,
    FeedbackSchedulerService,
    AiJobService,
  ],
  controllers: [AiJobController],
  exports: [
    AiJobService,
    QueueIdempotencyService,
    BullModule,
  ],
})
export class WorkersModule {}
