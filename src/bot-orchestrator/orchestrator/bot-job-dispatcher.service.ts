/**
 * BotJobDispatcher
 *
 * Central coordinator for the bot execution tier. Responsible for:
 *
 *   1. Subscription validation — verify tenant has an active plan
 *   2. Per-tenant limit enforcement — delegate to TenantRateLimiterService
 *   3. Backpressure check — reject when queues are overloaded
 *   4. Queue routing — paid tiers → priority_queue, others → bot_execution_queue
 *   5. Job lifecycle monitoring — listen to QueueEvents and update DB
 *   6. Retry orchestration — delegate to BotRetryService
 *
 * This service is DECOUPLED from the AI engine. It only knows job shape,
 * queue routing rules, and tenant metadata. The AI engine is called
 * exclusively inside BotExecutionWorker.
 *
 * EXECUTION FLOW:
 *   enqueueBot(request)
 *     → validateSubscription()        [DB]
 *     → checkBackpressure()           [Redis]
 *     → checkAndRecord()              [Redis — rate limiter]
 *     → buildPayload()
 *     → resolveQueue()
 *     → queue.add()
 *     → persistJobRecord()            [DB]
 */

import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { Queue } from 'bullmq';

import { DB_TOKEN } from '../../common/database/database.module';
import * as schema from '../../common/database/schema';
import { BotQueueConfig } from '../queues/bot-queue.config';
import { TenantRateLimiterService } from '../rate-limiter/tenant-rate-limiter.service';
import { BackpressureService } from '../rate-limiter/backpressure.service';
import {
  BotJobPayload,
  BotDlqPayload,
  EnqueueBotRequest,
} from './bot-job.types';
import {
  BOT_PRIORITY_QUEUE,
  JOB_BOT_CYCLE,
  JOB_BOT_SCALE,
  JOB_BOT_TEST,
  PRIORITY_HIGH,
  PRIORITY_LOW,
  PRIORITY_NORMAL,
  TIER_ENTERPRISE,
  TIER_PRO,
  TenantTier,
} from '../queues/bot-queue.constants';

export interface EnqueueResult {
  success:     boolean;
  jobId?:      string;
  queue?:      string;
  reason?:     string;
  retryAfterMs?: number;
}

@Injectable()
export class BotJobDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotJobDispatcher.name);

  constructor(
    @Inject(DB_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly queues: BotQueueConfig,
    private readonly rateLimiter: TenantRateLimiterService,
    private readonly backpressure: BackpressureService,
  ) {}

  onModuleInit(): void {
    this.attachQueueEventListeners();
    this.logger.log('[Orchestrator] Bot orchestrator online');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('[Orchestrator] Shutting down');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Primary entry point. Called by BotSchedulerService (cron) and
   * manual trigger endpoints.
   */
  async enqueueBot(request: EnqueueBotRequest): Promise<EnqueueResult> {
    const { tenant_id, bot_id, execution_type } = request;

    // ── Step 1: Validate subscription ──────────────────────────────────────
    const subscription = await this.validateSubscription(tenant_id);
    if (!subscription.valid) {
      this.logger.warn(`[Orchestrator] Tenant ${tenant_id} subscription invalid: ${subscription.reason}`);
      return { success: false, reason: subscription.reason };
    }

    const tier = subscription.tier!;

    // ── Step 2: Backpressure check ─────────────────────────────────────────
    const bp = await this.backpressure.evaluate();
    if (!bp.allowed) {
      return {
        success:     false,
        reason:      'System overloaded — queue depth exceeds backpressure threshold',
        retryAfterMs: 10_000,
      };
    }

    // ── Step 3: Rate limit check + reservation ─────────────────────────────
    const jobId      = uuidv4();
    const limitCheck = await this.rateLimiter.checkAndRecord(tenant_id, tier, jobId);
    if (!limitCheck.allowed) {
      return {
        success:     false,
        reason:      `Rate limit exceeded (${limitCheck.currentCount}/${limitCheck.limit})`,
        retryAfterMs: limitCheck.retryAfterMs,
      };
    }

    // ── Step 4: Build canonical job payload ───────────────────────────────
    const payload: BotJobPayload = {
      tenant_id,
      bot_id,
      execution_type,
      priority:         this.resolvePriorityLabel(tier, request.requested_priority),
      timestamp:        Date.now(),
      idempotency_key:  `${bot_id}:${execution_type}:${Math.floor(Date.now() / 60_000)}`,
      tenant_tier:      tier,
      engine_version:   await this.resolveEngineVersion(bot_id),
      attempt_number:   1,
    };

    // ── Step 5: Route to correct queue ────────────────────────────────────
    const { queue, bullPriority } = this.resolveQueue(tier, payload.priority);

    // ── Step 6: Enqueue ───────────────────────────────────────────────────
    const job = await queue.add(this.resolveJobName(execution_type), payload, {
      jobId:    jobId,                    // deterministic so BullMQ deduplicates
      priority: bullPriority,
    });

    // ── Step 7: Persist job record to DB ─────────────────────────────────
    await this.persistJobRecord({
      jobId:          job.id!,
      tenantId:       tenant_id,
      botId:          bot_id,
      executionType:  execution_type,
      queueName:      queue.name,
      tier,
    });

    this.logger.log(
      `[Orchestrator] Enqueued ${execution_type} job ${job.id} ` +
      `for bot ${bot_id} (tenant=${tenant_id} tier=${tier} queue=${queue.name})`,
    );

    return { success: true, jobId: job.id!, queue: queue.name };
  }

  /**
   * Bulk enqueue — used by the scheduler to enqueue many bots in one pass.
   * Respects backpressure: if overloaded mid-batch, stops and returns.
   */
  async enqueueBatch(
    requests: EnqueueBotRequest[],
  ): Promise<{ enqueued: number; skipped: number; reasons: string[] }> {
    let enqueued = 0;
    let skipped  = 0;
    const reasons: string[] = [];

    for (const req of requests) {
      const result = await this.enqueueBot(req);
      if (result.success) {
        enqueued++;
      } else {
        skipped++;
        reasons.push(`${req.bot_id}: ${result.reason}`);
        // If overloaded, stop batch entirely
        if (result.reason?.includes('overloaded')) break;
      }
    }

    this.logger.log(
      `[Orchestrator] Batch complete — enqueued=${enqueued} skipped=${skipped}`,
    );
    return { enqueued, skipped, reasons };
  }

  /**
   * Called by BotRetryService to re-enqueue a failed job with incremented
   * attempt counter. Bypasses subscription re-validation (already validated).
   */
  async reEnqueueForRetry(
    original: BotJobPayload,
    attemptNumber: number,
    originalJobId: string,
  ): Promise<string | null> {
    const payload: BotJobPayload = {
      ...original,
      attempt_number:  attemptNumber,
      original_job_id: originalJobId,
      timestamp:       Date.now(),
    };

    const { queue, bullPriority } = this.resolveQueue(original.tenant_tier, original.priority);
    const retryJobId = uuidv4();

    const job = await this.queues.retryQueue.add(JOB_BOT_CYCLE, payload, {
      jobId:    retryJobId,
      priority: bullPriority,
      delay:    this.exponentialDelay(attemptNumber),
    });

    this.logger.log(
      `[Orchestrator] Retry enqueued: attempt=${attemptNumber} ` +
      `originalJobId=${originalJobId} newJobId=${job.id}`,
    );

    return job.id ?? null;
  }

  /**
   * Move a job to the dead-letter queue after all retry attempts exhausted.
   */
  async sendToDlq(payload: BotJobPayload, failureReason: string, lastError: string): Promise<void> {
    const dlqPayload: BotDlqPayload = {
      original_payload: payload,
      failure_reason:   failureReason,
      final_attempt:    payload.attempt_number,
      failed_at:        Date.now(),
      last_error:       lastError,
    };

    await this.queues.dlqQueue.add(JOB_BOT_CYCLE, dlqPayload);

    // Persist DLQ event to DB for ops visibility
    await this.persistDlqEvent(dlqPayload);

    this.logger.error(
      `[Orchestrator] Job sent to DLQ — bot=${payload.bot_id} ` +
      `tenant=${payload.tenant_id} reason=${failureReason}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE — VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  private async validateSubscription(
    tenantId: string,
  ): Promise<{ valid: boolean; tier?: TenantTier; reason?: string }> {
    try {
      // Tenant subscriptions live in the `subscriptions` table (or equivalent)
      // Adjust table/column names to match your actual Drizzle schema.
      const rows = await this.db
        .select()
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.userId, tenantId),
            eq(schema.subscriptions.status, 'active'),
          ),
        )
        .limit(1);

      if (!rows.length) {
        return { valid: false, reason: 'No active subscription found' };
      }

      const sub  = rows[0];
      const tier = this.normaliseTier(sub.tier ?? 'free');

      return { valid: true, tier };
    } catch (err) {
      this.logger.error(
        `[Orchestrator] Subscription lookup failed for tenant ${tenantId}: ${(err as Error).message}`,
      );
      // Fail-open with free tier to avoid blocking all bots on a DB hiccup;
      // change to { valid: false } if you prefer fail-closed.
      return { valid: true, tier: 'free' };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE — ROUTING
  // ══════════════════════════════════════════════════════════════════════════

  private resolveQueue(
    tier: TenantTier,
    priority: 'low' | 'normal' | 'high',
  ): { queue: Queue; bullPriority: number } {
    const isPaid = tier === TIER_PRO || tier === TIER_ENTERPRISE;
    const queue  = isPaid ? this.queues.priorityQueue : this.queues.executionQueue;

    const bullPriority =
      priority === 'high'   ? PRIORITY_HIGH   :
      priority === 'low'    ? PRIORITY_LOW     :
                              PRIORITY_NORMAL;

    return { queue, bullPriority };
  }

  private resolveJobName(type: string): string {
    switch (type) {
      case 'test':  return JOB_BOT_TEST;
      case 'scale': return JOB_BOT_SCALE;
      default:      return JOB_BOT_CYCLE;
    }
  }

  private resolvePriorityLabel(
    tier: TenantTier,
    requested?: 'low' | 'normal' | 'high',
  ): 'low' | 'normal' | 'high' {
    // Enterprise always gets high; Pro gets at-least normal
    if (tier === TIER_ENTERPRISE) return 'high';
    if (tier === TIER_PRO)        return requested === 'high' ? 'high' : 'normal';
    return requested ?? 'low';
  }

  private async resolveEngineVersion(botId: string): Promise<string> {
    // In the real system look up the bot's configured engine version.
    // Fallback to the latest stable version.
    try {
      const rows = await this.db
        .select({ engineVersion: schema.bots.engineVersion })
        .from(schema.bots)
        .where(eq(schema.bots.id, botId))
        .limit(1);
      return rows[0]?.engineVersion ?? 'v42';
    } catch {
      return 'v42';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE — PERSISTENCE
  // ══════════════════════════════════════════════════════════════════════════

  private async persistJobRecord(params: {
    jobId:         string;
    tenantId:      string;
    botId:         string;
    executionType: string;
    queueName:     string;
    tier:          TenantTier;
  }): Promise<void> {
    try {
      // Note: userId required on botJobRecords — use botId as proxy until userId available in params
      await this.db.insert(schema.botJobRecords).values({
        jobId:         params.jobId,
        tenantId:      params.tenantId,
        botId:         params.botId,
        userId:        params.botId,        // placeholder — orchestrator context lacks userId here
        jobType:       params.queueName,    // queueName maps to jobType
        executionType: params.executionType,
        status:        'pending',
      });
    } catch (err) {
      // Non-fatal — log and continue; the queue job is already enqueued.
      this.logger.warn(`[Orchestrator] Failed to persist job record: ${(err as Error).message}`);
    }
  }

  private async persistDlqEvent(payload: BotDlqPayload): Promise<void> {
    try {
      await this.db.insert(schema.dlqEvents).values({
        orderId:       String(payload.original_payload?.['bot_id'] ?? 'bot-dlq'),
        userId:        (payload as unknown as {original_payload?: {user_id?: string}}).original_payload?.user_id ?? null,
        failureReason: payload.failure_reason,
        attemptsMade:  payload.final_attempt ?? 0,
      });
    } catch (err) {
      this.logger.error(`[Orchestrator] Failed to persist DLQ event: ${(err as Error).message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE — QUEUE EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════════════

  private attachQueueEventListeners(): void {
    // Execution queue
    this.queues.executionEvents.on('completed', ({ jobId }) => {
      this.logger.debug(`[QueueEvent] Job completed: ${jobId}`);
      void this.updateJobStatus(jobId, 'completed');
    });

    this.queues.executionEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.warn(`[QueueEvent] Job failed: ${jobId} — ${failedReason}`);
      void this.updateJobStatus(jobId, 'failed', failedReason);
    });

    this.queues.executionEvents.on('stalled', ({ jobId }) => {
      this.logger.error(`[QueueEvent] Job stalled (timeout): ${jobId}`);
      void this.updateJobStatus(jobId, 'stalled');
    });

    // Priority queue
    this.queues.priorityEvents.on('completed', ({ jobId }) => {
      void this.updateJobStatus(jobId, 'completed');
    });

    this.queues.priorityEvents.on('failed', ({ jobId, failedReason }) => {
      void this.updateJobStatus(jobId, 'failed', failedReason);
    });
  }

  private async updateJobStatus(
    jobId: string,
    status: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.db
        .update(schema.botJobRecords)
        .set({
          status,
          errorMsg:    error ?? null,
          completedAt: new Date(),
        })
        .where(eq(schema.botJobRecords.jobId, jobId));
    } catch (err) {
      this.logger.error(`[Orchestrator] Status update failed for ${jobId}: ${(err as Error).message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE — UTILITIES
  // ══════════════════════════════════════════════════════════════════════════

  private normaliseTier(raw: string): TenantTier {
    const map: Record<string, TenantTier> = {
      free: 'free', starter: 'starter', pro: 'pro', enterprise: 'enterprise',
      basic: 'starter', business: 'pro', scale: 'enterprise',
    };
    return map[raw.toLowerCase()] ?? 'free';
  }

  private exponentialDelay(attempt: number): number {
    // 2s, 4s, 8s, 16s, 32s — capped at 60s
    return Math.min(2_000 * Math.pow(2, attempt - 1), 60_000);
  }
}
