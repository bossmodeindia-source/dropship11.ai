/**
 * commerce-brain.schema.ts
 *
 * Drizzle ORM schema for CommerceBrain learning + decision persistence.
 *
 * Tables:
 *   brain_memory          — consolidated cross-cycle learned knowledge
 *   brain_learning_signals — raw per-event learning signals (ring buffer)
 *   brain_decisions        — audit log of all Brain decisions
 *   commerce_plans         — full CommercePlan records per tenant cycle
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  integer,
  jsonb,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ── Enums ──────────────────────────────────────────────────────────────────────

export const brainMemoryCategoryEnum = pgEnum('brain_memory_category', [
  'winning_creative',
  'failing_creative',
  'viral_hook',
  'profitable_audience',
  'supplier_reliability',
  'roas_history',
  'viral_pattern',
  'platform_engagement',
  'campaign_failure',
  'high_converting_page',
  'seo_signal',
  'ai_discoverability',
]);

export const planStatusEnum = pgEnum('commerce_plan_status', [
  'draft', 'approved', 'executing', 'completed', 'failed',
]);

// ── brain_memory ──────────────────────────────────────────────────────────────
// Consolidated knowledge per tenant + category + key.
// Upserted on every learning signal — keeps the single best version.

export const brainMemory = pgTable(
  'brain_memory',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    tenantId:     uuid('tenant_id').notNull(),
    category:     brainMemoryCategoryEnum('category').notNull(),
    memoryKey:    varchar('memory_key', { length: 512 }).notNull(),
    value:        jsonb('value').notNull().default({}),
    successScore: numeric('success_score', { precision: 5, scale: 4 }).notNull().default('0'),
    hitCount:     integer('hit_count').notNull().default(1),
    platform:     varchar('platform', { length: 64 }),
    niche:        varchar('niche', { length: 128 }),
    geography:    varchar('geography', { length: 64 }),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueKey:    uniqueIndex('brain_memory_unique_key').on(t.tenantId, t.category, t.memoryKey),
    idxTenant:    index('brain_memory_tenant_idx').on(t.tenantId),
    idxCategory:  index('brain_memory_category_idx').on(t.category),
    idxScore:     index('brain_memory_score_idx').on(t.successScore),
  }),
);

// ── brain_learning_signals ────────────────────────────────────────────────────
// Raw per-outcome learning events — append-only ring buffer.
// Consolidated into brain_memory every hour by LearningBrain.

export const brainLearningSignals = pgTable(
  'brain_learning_signals',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    tenantId:     uuid('tenant_id').notNull(),
    category:     brainMemoryCategoryEnum('category').notNull(),
    memoryKey:    varchar('memory_key', { length: 512 }).notNull(),
    value:        jsonb('value').notNull().default({}),
    successScore: numeric('success_score', { precision: 5, scale: 4 }).notNull(),
    platform:     varchar('platform', { length: 64 }),
    niche:        varchar('niche', { length: 128 }),
    geography:    varchar('geography', { length: 64 }),
    expiresAt:    timestamp('expires_at', { withTimezone: true }),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTenant:   index('brain_signals_tenant_idx').on(t.tenantId),
    idxCategory: index('brain_signals_category_idx').on(t.category),
    idxCreated:  index('brain_signals_created_idx').on(t.createdAt),
  }),
);

// ── brain_decisions ───────────────────────────────────────────────────────────
// Audit log — every Brain decision written here for replay + governance.

export const brainDecisions = pgTable(
  'brain_decisions',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    tenantId:   uuid('tenant_id').notNull(),
    brainType:  varchar('brain_type', { length: 64 }).notNull(),
    decision:   text('decision').notNull(),
    reasoning:  text('reasoning'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    metadata:   jsonb('metadata').notNull().default({}),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTenant:  index('brain_decisions_tenant_idx').on(t.tenantId),
    idxType:    index('brain_decisions_type_idx').on(t.brainType),
    idxCreated: index('brain_decisions_created_idx').on(t.createdAt),
  }),
);

// ── commerce_plans ────────────────────────────────────────────────────────────
// Full CommercePlan record per tenant cycle.

export const commercePlans = pgTable(
  'commerce_plans',
  {
    id:                 uuid('id').primaryKey(),
    tenantId:           uuid('tenant_id').notNull(),
    cycleStartedAt:     timestamp('cycle_started_at', { withTimezone: true }).notNull(),
    trendSignals:       jsonb('trend_signals').notNull().default([]),
    productDecisions:   jsonb('product_decisions').notNull().default([]),
    audienceProfiles:   jsonb('audience_profiles').notNull().default([]),
    creativeDirections: jsonb('creative_directions').notNull().default([]),
    pricingRecs:        jsonb('pricing_recs').notNull().default([]),
    growthLoops:        jsonb('growth_loops').notNull().default([]),
    estimatedRoas:      numeric('estimated_roas', { precision: 8, scale: 4 }).notNull().default('0'),
    confidence:         numeric('confidence', { precision: 5, scale: 4 }).notNull().default('0'),
    planStatus:         planStatusEnum('plan_status').notNull().default('draft'),
    createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTenant:  index('commerce_plans_tenant_idx').on(t.tenantId),
    idxStatus:  index('commerce_plans_status_idx').on(t.planStatus),
    idxCreated: index('commerce_plans_created_idx').on(t.cycleStartedAt),
  }),
);
