/**
 * trend-intelligence.schema.ts
 * Drizzle schema for trend signal persistence.
 */

import {
  pgTable, uuid, varchar, numeric, jsonb,
  timestamp, index, pgEnum,
} from 'drizzle-orm/pg-core';

export const trendPlatformEnum = pgEnum('trend_platform', [
  'google', 'tiktok', 'meta', 'reddit', 'amazon', 'shopify', 'youtube',
]);

export const trendSignals = pgTable(
  'trend_signals',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    platform:     trendPlatformEnum('platform').notNull(),
    keyword:      varchar('keyword', { length: 256 }).notNull(),
    trendScore:   numeric('trend_score', { precision: 6, scale: 2 }).notNull(),
    velocity:     numeric('velocity', { precision: 8, scale: 2 }).notNull().default('0'),
    saturation:   numeric('saturation', { precision: 5, scale: 4 }).notNull().default('0'),
    relatedTerms: jsonb('related_terms').notNull().default([]),
    category:     varchar('category', { length: 128 }),
    geography:    varchar('geography', { length: 8 }).notNull().default('IN'),
    rawData:      jsonb('raw_data').notNull().default({}),
    capturedAt:   timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxPlatform:  index('trend_signals_platform_idx').on(t.platform),
    idxKeyword:   index('trend_signals_keyword_idx').on(t.keyword),
    idxScore:     index('trend_signals_score_idx').on(t.trendScore),
    idxCaptured:  index('trend_signals_captured_idx').on(t.capturedAt),
  }),
);
