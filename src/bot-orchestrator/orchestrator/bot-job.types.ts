/**
 * Bot Job Payload Types
 *
 * Canonical shape for every job that flows through the queue system.
 * Workers receive BotJobPayload; they never trust any other shape.
 */

import { ExecutionType, JobPriority, TenantTier } from '../queues/bot-queue.constants';

// ── Core job payload ───────────────────────────────────────────────────────────
export interface BotJobPayload {
  /** Which tenant this job belongs to — used for rate limiting + partitioning */
  tenant_id: string;

  /** The specific bot instance to execute */
  bot_id: string;

  /** What kind of execution this is */
  execution_type: ExecutionType;

  /** Job priority signal — the queue itself enforces actual ordering */
  priority: JobPriority;

  /** Unix epoch ms — when the job was created by the orchestrator */
  timestamp: number;

  /** Optional raw original payload when this is a DLQ retry */
  original_payload?: Record<string, unknown>;

  // ── Enriched fields added by orchestrator before enqueue ─────────────────
  /** Internal dedup key — prevents double-enqueue within a window */
  idempotency_key: string;

  /** Tenant subscription tier — determines which queue to use */
  tenant_tier: TenantTier;

  /** The AI engine version slug for this bot (e.g. "v42", "v29") */
  engine_version: string;

  /** Retry counter — incremented by RetryService before re-enqueue */
  attempt_number: number;

  /** If this is a retry, the original job's Bull ID for lineage tracking */
  original_job_id?: string;
}

// ── DLQ payload — wraps the original payload with failure context ──────────────
export interface BotDlqPayload {
  original_payload: BotJobPayload;
  failure_reason:   string;
  final_attempt:    number;
  failed_at:        number;   // Unix epoch ms
  last_error:       string;
}

// ── Enqueue request — what callers pass to OrchestratorService ────────────────
export interface EnqueueBotRequest {
  tenant_id:      string;
  bot_id:         string;
  execution_type: ExecutionType;
  /** Caller can request a priority; orchestrator may downgrade based on tier */
  requested_priority?: JobPriority;
}

// ── Execution result — what workers write back to DB/Redis ────────────────────
export interface BotExecutionResult {
  bot_id:        string;
  tenant_id:     string;
  job_id:        string;
  status:        'success' | 'partial' | 'failed';
  engine_output: Record<string, unknown>;
  duration_ms:   number;
  completed_at:  number;
  error?:        string;
}
