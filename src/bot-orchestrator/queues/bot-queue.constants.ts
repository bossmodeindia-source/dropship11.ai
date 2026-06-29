/**
 * Bot Queue Constants
 *
 * Three queues form the execution tier:
 *
 *   BOT_EXECUTION_QUEUE  — standard bot cycles (free / starter tenants)
 *   BOT_PRIORITY_QUEUE   — paid tier (pro / enterprise) — lower latency SLA
 *   BOT_RETRY_QUEUE      — exponential-backoff retries for soft failures
 *   BOT_DLQ              — dead-letter: jobs that exhausted all retries
 *
 * Partition key: all jobs carry tenant_id so a future sharding layer can
 * route partitions to dedicated worker groups without changing job shape.
 */

// ── Queue names ────────────────────────────────────────────────────────────────
export const BOT_EXECUTION_QUEUE = 'bot_execution_queue' as const;
export const BOT_PRIORITY_QUEUE  = 'priority_queue'      as const;
export const BOT_RETRY_QUEUE     = 'retry_queue'          as const;
export const BOT_DLQ             = 'bot_dlq'              as const;

// ── Job names (processor discriminator) ───────────────────────────────────────
export const JOB_BOT_CYCLE  = 'bot:cycle'  as const;   // scheduled execution
export const JOB_BOT_TEST   = 'bot:test'   as const;   // manual test run
export const JOB_BOT_SCALE  = 'bot:scale'  as const;   // scale-triggered run
export const JOB_BOT_RETRY  = 'bot:retry'  as const;   // retry wrapper
export const JOB_BOT_DLQ    = 'bot:dlq'    as const;   // dead-letter handler

// ── Priority values (BullMQ: lower number = higher priority) ──────────────────
export const PRIORITY_HIGH   = 1 as const;
export const PRIORITY_NORMAL = 5 as const;
export const PRIORITY_LOW    = 10 as const;

// ── Tenant subscription tiers ─────────────────────────────────────────────────
export const TIER_FREE       = 'free'       as const;
export const TIER_STARTER    = 'starter'    as const;
export const TIER_PRO        = 'pro'        as const;
export const TIER_ENTERPRISE = 'enterprise' as const;

export type TenantTier =
  | typeof TIER_FREE
  | typeof TIER_STARTER
  | typeof TIER_PRO
  | typeof TIER_ENTERPRISE;

export type ExecutionType = 'cycle' | 'test' | 'scale';
export type JobPriority   = 'low' | 'normal' | 'high';

// ── Concurrency caps per worker process ───────────────────────────────────────
// These are per-worker-process values. Scale horizontally to multiply throughput.
// 800 bots / (concurrency per worker) = minimum worker processes needed.
export const WORKER_CONCURRENCY_EXECUTION = 40;   // 20 workers × 40 = 800 slots
export const WORKER_CONCURRENCY_PRIORITY  = 20;   // higher-SLA, tighter pool
export const WORKER_CONCURRENCY_RETRY     = 10;   // throttled to avoid thundering herd

// ── Retry policy ──────────────────────────────────────────────────────────────
export const MAX_RETRY_ATTEMPTS    = 5;
export const RETRY_BASE_DELAY_MS   = 2_000;   // 2s base for exponential backoff
export const JOB_TIMEOUT_MS        = 120_000;  // 2 min hard timeout per job

// ── Rate limiting ─────────────────────────────────────────────────────────────
export const GLOBAL_CONCURRENCY_CAP   = 800;
export const QUEUE_SIZE_WARNING_MARK  = 2_000;  // alert threshold
export const QUEUE_SIZE_BACKPRESSURE  = 5_000;  // reject new enqueues above this

// Per-tier execution window limits (jobs per window)
export const TIER_LIMITS: Record<TenantTier, { maxJobs: number; windowMs: number }> = {
  free:       { maxJobs: 10,  windowMs: 60_000 },   // 10/min
  starter:    { maxJobs: 30,  windowMs: 60_000 },   // 30/min
  pro:        { maxJobs: 100, windowMs: 60_000 },   // 100/min
  enterprise: { maxJobs: 500, windowMs: 60_000 },   // 500/min
};
