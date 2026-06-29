/**
 * BotOrchestratorModule — V57 Bot Queue + Execution Tier
 *
 * Self-contained NestJS module. Import into AppModule to activate the full
 * BullMQ queue + orchestration system.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   BotSchedulerService  (cron: every 5 min)
 *     └─► BotJobDispatcher.enqueueBot()
 *           ├── validateSubscription()   [Drizzle / Postgres]
 *           ├── checkBackpressure()      [Redis queue depth]
 *           ├── checkAndRecord()         [Redis rate limiter per tenant]
 *           ├── buildPayload()           [enriches job with tier/engine info]
 *           ├── resolveQueue()           [PRO/ENTERPRISE → priorityQueue]
 *           └── queue.add()              [BullMQ enqueue]
 *                  │
 *         ┌────────┴─────────┐
 *   BotExecutionWorker   BotDlqWorker
 *     └── AiEngineDispatcher   └── DLQ audit + alert
 *          └── AiOrchestratorModule
 *
 * QUEUES (BullMQ / Redis):
 *   bot_execution_queue  — standard bot cycles (free / starter)
 *   priority_queue       — low-latency path for pro / enterprise
 *   retry_queue          — exponential-backoff retry lane
 *   bot_dlq              — dead-letter: jobs that exhausted all retries
 *
 * SCALE:
 *   Run worker.boot.js separately for horizontal scaling.
 *   See docker-compose.workers.yml for fleet config (800 concurrent bots).
 *
 * DEPENDENCIES (all @Global — no explicit imports needed):
 *   DatabaseModule, RedisModule, JwtAuthGuard, ConfigModule
 *
 * NON-GLOBAL DEPENDENCIES (imported explicitly):
 *   AiOrchestratorModule, NotificationsModule
 * ──────────────────────────────────────────────────────────────────────────
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { NotificationsModule }  from '../notifications/notifications.module';

// ── Queue infrastructure ───────────────────────────────────────────────────
import { BotQueueConfig } from './queues/bot-queue.config';

// ── Core services ─────────────────────────────────────────────────────────
import { BotJobDispatcher } from './orchestrator/bot-job-dispatcher.service';
import { BotSchedulerService }    from './scheduler/bot-scheduler.service';

// ── Workers ───────────────────────────────────────────────────────────────
import { BotExecutionWorker } from './workers/bot-execution.worker';
import { BotDlqWorker }       from './workers/bot-dlq.worker';

// ── Retry ─────────────────────────────────────────────────────────────────
import { BotRetryService } from './retry/bot-retry.service';

// ── Rate limiting + backpressure ──────────────────────────────────────────
import { TenantRateLimiterService } from './rate-limiter/tenant-rate-limiter.service';
import { BackpressureService }      from './rate-limiter/backpressure.service';

// ── Engine dispatcher ─────────────────────────────────────────────────────
import { AiEngineDispatcher } from './engine/ai-engine.dispatcher';

// ── Health / observability ────────────────────────────────────────────────
import { BotQueueHealthController } from './health/bot-queue-health.controller';

@Module({
  imports: [
    // ScheduleModule.forRoot() is idempotent in NestJS; safe to call per-module.
    // Explicitly declared here so BotOrchestratorModule is self-contained and
    // can be used in the standalone worker.boot.ts without a full AppModule.
    ScheduleModule.forRoot(),

    // Non-global module dependencies — must be imported explicitly.
    AiOrchestratorModule,
    NotificationsModule,

    // DatabaseModule, RedisModule, ConfigModule are @Global — auto-resolved.
    // AuthModule / JwtAuthGuard are @Global via AppModule APP_GUARD — auto-resolved.
  ],
  controllers: [
    BotQueueHealthController,
  ],
  providers: [
    // Queue config — MUST be first; workers + orchestrator depend on it.
    BotQueueConfig,

    // Rate limiting
    TenantRateLimiterService,
    BackpressureService,

    // Orchestrator — central coordinator for enqueue + lifecycle
    BotJobDispatcher,

    // Retry — re-enqueues soft failures with exponential backoff
    BotRetryService,

    // Engine dispatcher — routes jobs to the correct AI engine version
    AiEngineDispatcher,

    // Scheduler — triggers periodic bot cycles via cron
    BotSchedulerService,

    // Workers — consume queues; started in onModuleInit()
    BotExecutionWorker,
    BotDlqWorker,
  ],
  exports: [
    BotJobDispatcher,   // manual triggers from other modules
    BackpressureService,       // admin dashboards / health endpoints
    TenantRateLimiterService,
  ],
})
export class BotDispatchModule {}
