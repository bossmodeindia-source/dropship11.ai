/**
 * worker.boot.ts — Standalone Worker Process
 *
 * This entrypoint bootstraps a minimal NestJS app containing ONLY the
 * worker providers — no HTTP server, no scheduler, no orchestrator.
 *
 * Run horizontally to scale worker capacity:
 *
 *   # Standard execution workers
 *   BOT_WORKER_QUEUE=bot_execution_queue \
 *   BOT_WORKER_CONCURRENCY=40 \
 *   node dist/bot-orchestrator/worker.boot.js
 *
 *   # Priority queue workers
 *   BOT_WORKER_QUEUE=priority_queue \
 *   BOT_WORKER_CONCURRENCY=20 \
 *   node dist/bot-orchestrator/worker.boot.js
 *
 *   # DLQ workers (typically just 1-2 processes)
 *   BOT_WORKER_QUEUE=bot_dlq \
 *   node dist/bot-orchestrator/worker.boot.js
 *
 * Docker Compose / Kubernetes:
 *   Each worker type maps to its own Deployment/service.
 *   Autoscale on queue depth metrics exported via /bot-queue/metrics.
 *
 * Architecture note:
 *   Workers are stateless. They depend on Redis (queue) and Postgres (state).
 *   They never communicate directly with each other or with the orchestrator.
 */

import { NestFactory } from '@nestjs/core';
import { Module }      from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule }       from '../common/database/database.module';
import { RedisModule }          from '../common/redis/redis.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { NotificationsModule }  from '../notifications/notifications.module';

import { BotQueueConfig }         from './queues/bot-queue.config';
import { TenantRateLimiterService } from './rate-limiter/tenant-rate-limiter.service';
import { BotRetryService }        from './retry/bot-retry.service';
import { BotExecutionWorker }     from './workers/bot-execution.worker';
import { BotDlqWorker }           from './workers/bot-dlq.worker';
import { AiEngineDispatcher }     from './engine/ai-engine.dispatcher';
import { BotJobDispatcher } from './orchestrator/bot-job-dispatcher.service';
import { BackpressureService }    from './rate-limiter/backpressure.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RedisModule,
    AiOrchestratorModule,
    NotificationsModule,
  ],
  providers: [
    BotQueueConfig,
    TenantRateLimiterService,
    BackpressureService,
    BotJobDispatcher,
    BotRetryService,
    AiEngineDispatcher,
    BotExecutionWorker,
    BotDlqWorker,
  ],
})
class WorkerModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[Worker] SIGTERM received — graceful shutdown');
    await app.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[Worker] SIGINT received — graceful shutdown');
    await app.close();
    process.exit(0);
  });

  console.log(`[Worker] Process started — PID=${process.pid}`);
}

bootstrap().catch((err) => {
  console.error('[Worker] Bootstrap failed:', err);
  process.exit(1);
});
