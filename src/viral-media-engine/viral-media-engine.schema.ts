import {
  pgTable, uuid, varchar, boolean, integer,
  numeric, jsonb, timestamp, index, uniqueIndex, pgEnum,
} from 'drizzle-orm/pg-core';

export const viralMediaJobStatusEnum = pgEnum('viral_media_job_status', [
  'queued', 'trend_discovery', 'script_generation',
  'image_generation', 'video_generation', 'voice_generation',
  'assembly', 'scoring', 'variants', 'publishing',
  'completed', 'failed',
]);

export const viralMediaJobs = pgTable(
  'viral_media_jobs',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    tenantId:        uuid('tenant_id').notNull(),
    userId:          uuid('user_id').notNull(),
    productId:       uuid('product_id'),
    mediaType:       varchar('media_type', { length: 64 }).notNull(),
    targetPlatforms: jsonb('target_platforms').notNull().default([]),
    variantCount:    integer('variant_count').notNull().default(1),
    autoPublish:     boolean('auto_publish').notNull().default(false),
    idempotencyKey:  varchar('idempotency_key', { length: 512 }).notNull(),
    status:          viralMediaJobStatusEnum('status').notNull().default('queued'),
    assets:          jsonb('assets').notNull().default([]),
    viralityScores:  jsonb('virality_scores').notNull().default([]),
    publishedUrls:   jsonb('published_urls').notNull().default([]),
    estimatedRoas:   numeric('estimated_roas', { precision: 8, scale: 4 }).notNull().default('0'),
    errorMessage:    varchar('error_message', { length: 2048 }),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTenant:      index('viral_media_tenant_idx').on(t.tenantId),
    idxStatus:      index('viral_media_status_idx').on(t.status),
    idxCreated:     index('viral_media_created_idx').on(t.createdAt),
    uniqueIdem:     uniqueIndex('viral_media_idempotency_idx').on(t.idempotencyKey),
  }),
);
