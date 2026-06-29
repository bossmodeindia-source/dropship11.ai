/**
 * canonical-queues.ts — V60 CANONICAL QUEUE REGISTRY
 *
 * SINGLE SOURCE OF TRUTH for all BullMQ queue names.
 *
 * Rule: NO queue may be created unless it is listed here.
 * Any queue referenced anywhere in the codebase MUST use these constants.
 *
 * Canonical queues (10 total):
 *   1.  product-discovery     — product signal ingestion + evaluation
 *   2.  creative-generation   — AI asset generation (images, copy, video scripts)
 *   3.  campaign-launch       — paid + organic campaign dispatching
 *   4.  organic-posting       — social post scheduling + publishing
 *   5.  shopify-sync          — Shopify product/order bidirectional sync
 *   6.  order-processing      — order state machine (new → confirmed → shipped)
 *   7.  supplier-fulfillment  — supplier dispatch + tracking updates
 *   8.  analytics             — event ingestion + aggregation pipeline
 *   9.  learning-loop         — ML feedback + model update cycle
 *   10. alerts                — critical alert dispatch (Telegram + email)
 *
 * Dead-letter queues (mirror of above, prefixed with dlq:):
 *   Each canonical queue has a corresponding DLQ for failed jobs.
 */

export enum CanonicalQueue {
  PRODUCT_DISCOVERY    = 'product-discovery',
  CREATIVE_GENERATION  = 'creative-generation',
  CAMPAIGN_LAUNCH      = 'campaign-launch',
  ORGANIC_POSTING      = 'organic-posting',
  SHOPIFY_SYNC         = 'shopify-sync',
  ORDER_PROCESSING     = 'order-processing',
  SUPPLIER_FULFILLMENT = 'supplier-fulfillment',
  ANALYTICS            = 'analytics',
  LEARNING_LOOP        = 'learning-loop',
  ALERTS               = 'alerts',

  // ── Telegram Storage Infrastructure (V60) ─────────────────────────────────
  TG_UPLOAD            = 'telegram:upload',
  TG_REPLICATION       = 'telegram:replication',
  TG_HEALTH_MONITOR    = 'telegram:health-monitor',
  TG_RETENTION         = 'telegram:retention',
}

export enum DLQ {
  PRODUCT_DISCOVERY    = 'dlq:product-discovery',
  CREATIVE_GENERATION  = 'dlq:creative-generation',
  CAMPAIGN_LAUNCH      = 'dlq:campaign-launch',
  ORGANIC_POSTING      = 'dlq:organic-posting',
  SHOPIFY_SYNC         = 'dlq:shopify-sync',
  ORDER_PROCESSING     = 'dlq:order-processing',
  SUPPLIER_FULFILLMENT = 'dlq:supplier-fulfillment',
  ANALYTICS            = 'dlq:analytics',
  LEARNING_LOOP        = 'dlq:learning-loop',
  ALERTS               = 'dlq:alerts',
}

/** All canonical queues as an array — for BullModule.registerQueue() spread */
export const ALL_CANONICAL_QUEUES: string[] = Object.values(CanonicalQueue);

/** All DLQs as an array */
export const ALL_DLQS: string[] = Object.values(DLQ);

/** Default BullMQ job options applied to ALL jobs unless overridden */
export const DEFAULT_JOB_OPTIONS = {
  attempts:          5,
  backoff: {
    type:  'exponential' as const,
    delay: 2_000,
  },
  removeOnComplete:  { count: 500, age: 86_400 },  // keep 500 completed, max 1 day
  removeOnFail:      { count: 200, age: 604_800 },  // keep 200 failed, max 1 week
} as const;

/** Job names per queue — prevents string typos */
export const JobName = {
  [CanonicalQueue.PRODUCT_DISCOVERY]: {
    DISCOVER:     'discover',
    APPROVE:      'approve',
    REJECT:       'reject',
  },
  [CanonicalQueue.CREATIVE_GENERATION]: {
    GENERATE:     'generate',
    SCORE:        'score',
    AB_TEST:      'ab-test',
  },
  [CanonicalQueue.CAMPAIGN_LAUNCH]: {
    LAUNCH_PAID:  'launch-paid',
    LAUNCH_ORGANIC: 'launch-organic',
    SCALE_UP:     'scale-up',
    SCALE_DOWN:   'scale-down',
    PAUSE:        'pause',
    STOP:         'stop',
  },
  [CanonicalQueue.SHOPIFY_SYNC]: {
    SYNC_PRODUCT: 'sync-product',
    SYNC_ORDER:   'sync-order',
    SYNC_INVENTORY: 'sync-inventory',
  },
  [CanonicalQueue.ORDER_PROCESSING]: {
    PROCESS_NEW:  'process-new',
    CONFIRM:      'confirm',
    FULFILLMENT_UPDATE: 'fulfillment-update',
    REFUND:       'refund',
  },
  [CanonicalQueue.SUPPLIER_FULFILLMENT]: {
    DISPATCH:     'dispatch',
    TRACK:        'track',
    CONFIRM_DELIVERY: 'confirm-delivery',
  },
  [CanonicalQueue.ANALYTICS]: {
    INGEST_EVENT: 'ingest-event',
    AGGREGATE:    'aggregate',
    EXPORT:       'export',
  },
  [CanonicalQueue.LEARNING_LOOP]: {
    PROCESS:      'process',
    UPDATE_MODEL: 'update-model',
  },
  [CanonicalQueue.ALERTS]: {
    SEND_CRITICAL:  'send-critical',
    SEND_WARNING:   'send-warning',
    SEND_INFO:      'send-info',
  },
} as const;
