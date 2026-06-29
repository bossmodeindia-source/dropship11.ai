/**
 * Queue Constants (V2 — Extended)
 *
 * V1 queues preserved (unchanged):
 *   ORDER_QUEUE / ORDER_DLQ — Shopify order processing
 *
 * V2 AI queues (new):
 *   AI_CRITICAL_QUEUE   — product scoring, time-sensitive        (concurrency 10)
 *   AI_STANDARD_QUEUE   — listings, campaign generation          (concurrency 5)
 *   AI_BACKGROUND_QUEUE — media, memory harvest, cache eviction  (concurrency 2)
 */

// ── V1 (unchanged) ────────────────────────────────────────────────────────────
export const ORDER_QUEUE = 'order:process';
export const ORDER_DLQ   = 'order:dlq';

// ── V2 AI queues ──────────────────────────────────────────────────────────────
export const AI_CRITICAL_QUEUE   = 'ai:critical';
export const AI_STANDARD_QUEUE   = 'ai:standard';
export const AI_BACKGROUND_QUEUE = 'ai:background';

// ── Job name constants ────────────────────────────────────────────────────────
export const JOB_SCORING_EVALUATE  = 'scoring:evaluate';
export const JOB_LISTING_GENERATE  = 'listing:generate';
export const JOB_CAMPAIGN_GENERATE = 'campaign:generate';
export const JOB_HOOKS_GENERATE    = 'hooks:generate';
export const JOB_CAPTIONS_GENERATE = 'captions:generate';
export const JOB_MEDIA_GENERATE    = 'media:generate';
export const JOB_MEMORY_HARVEST    = 'feedback:harvest';
export const JOB_CACHE_EVICT       = 'cache:evict';

// ── Job status ────────────────────────────────────────────────────────────────
export const JOB_STATUS_PENDING    = 'pending'    as const;
export const JOB_STATUS_PROCESSING = 'processing' as const;
export const JOB_STATUS_DONE       = 'done'       as const;
export const JOB_STATUS_FAILED     = 'failed'     as const;

export type JobStatus =
  | typeof JOB_STATUS_PENDING
  | typeof JOB_STATUS_PROCESSING
  | typeof JOB_STATUS_DONE
  | typeof JOB_STATUS_FAILED;
