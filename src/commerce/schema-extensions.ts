/**
 * Commerce Execution Layer — Schema Extensions
 *
 * New tables for:
 *   - commission_config      : Admin-managed hidden commission rules
 *   - organic_posts          : Scheduled / published organic social posts
 *   - engagement_metrics     : Per-post engagement (likes, views, shares)
 *   - supplier_payments      : Supplier payment records per order
 *   - campaign_modes         : Per-campaign mode config (paid | organic | hybrid)
 *   - product_approvals      : User approval workflow for discovered products
 *
 * Import alongside the main schema in any service that needs these tables.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core';

import { users, products, campaigns, orders } from '../common/database/schema';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const campaignModeEnum = pgEnum('campaign_mode', [
  'paid',
  'organic',
  'hybrid',
]);

export const commissionTypeEnum = pgEnum('commission_type', [
  'fixed',
  'percentage',
]);

export const organicPostStatusEnum = pgEnum('organic_post_status', [
  'pending',
  'scheduled',
  'published',
  'failed',
  'boosted',
]);

export const organicPlatformEnum = pgEnum('organic_platform', [
  'instagram',
  'facebook',
  'instagram_reels',
  'facebook_reels',
]);

export const supplierPaymentStatusEnum = pgEnum('supplier_payment_status', [
  'pending',
  'initiated',
  'paid',
  'failed',
]);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
]);

// ── Commission Config ─────────────────────────────────────────────────────────
// Admin-only table. Users NEVER see commission fields — only the final
// `minimum_user_price` (= supplier_price + commission) is exposed to users.

export const commissionConfig = pgTable('commission_config', {
  id:                uuid('id').primaryKey().defaultRandom(),
  isEnabled:         boolean('is_enabled').notNull().default(true),
  commissionType:    commissionTypeEnum('commission_type').notNull().default('fixed'),
  fixedAmount:       numeric('fixed_amount',    { precision: 12, scale: 2 }).default('0'),
  percentage:        numeric('percentage',       { precision: 5,  scale: 2 }).default('0'),
  appliedToCategory: varchar('applied_to_category', { length: 100 }),  // null = all
  minOrderValue:     numeric('min_order_value', { precision: 12, scale: 2 }).default('0'),
  notes:             text('notes'),
  createdBy:         uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Product Approvals ────────────────────────────────────────────────────────
// Tracks user approval decision for each bot-discovered product.

export const productApprovals = pgTable('product_approvals', {
  id:             uuid('id').primaryKey().defaultRandom(),
  productId:      uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  userId:         uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status:         approvalStatusEnum('status').notNull().default('pending'),
  sellingPrice:   numeric('selling_price', { precision: 12, scale: 2 }),
  campaignMode:   campaignModeEnum('campaign_mode').notNull().default('organic'),
  rejectedReason: text('rejected_reason'),
  approvedAt:     timestamp('approved_at', { withTimezone: true }),
  createdAt:      timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at',  { withTimezone: true }).notNull().defaultNow(),
});

// ── Organic Posts ─────────────────────────────────────────────────────────────

export const organicPosts = pgTable('organic_posts', {
  id:               uuid('id').primaryKey().defaultRandom(),
  userId:           uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  productId:        uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  campaignId:       uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  platform:         organicPlatformEnum('platform').notNull(),
  status:           organicPostStatusEnum('status').notNull().default('pending'),
  caption:          text('caption').notNull(),
  hashtags:         text('hashtags').array().notNull().default([]),
  hook:             text('hook'),
  mediaUrls:        text('media_urls').array().notNull().default([]),
  videoScript:      jsonb('video_script').default({}),
  externalPostId:   varchar('external_post_id', { length: 255 }),
  externalPostUrl:  text('external_post_url'),
  scheduledAt:      timestamp('scheduled_at', { withTimezone: true }),
  publishedAt:      timestamp('published_at', { withTimezone: true }),
  failureReason:    text('failure_reason'),
  boostCampaignId:  varchar('boost_campaign_id', { length: 255 }),
  isBoosted:        boolean('is_boosted').notNull().default(false),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Engagement Metrics ────────────────────────────────────────────────────────

export const engagementMetrics = pgTable('engagement_metrics', {
  id:              uuid('id').primaryKey().defaultRandom(),
  organicPostId:   uuid('organic_post_id').notNull().references(() => organicPosts.id, { onDelete: 'cascade' }),
  platform:        organicPlatformEnum('platform').notNull(),
  views:           integer('views').notNull().default(0),
  likes:           integer('likes').notNull().default(0),
  comments:        integer('comments').notNull().default(0),
  shares:          integer('shares').notNull().default(0),
  saves:           integer('saves').notNull().default(0),
  reach:           integer('reach').notNull().default(0),
  engagementRate:  numeric('engagement_rate', { precision: 7, scale: 4 }),
  clickThroughs:   integer('click_throughs').notNull().default(0),
  fetchedAt:       timestamp('fetched_at',  { withTimezone: true }).notNull().defaultNow(),
  createdAt:       timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
});

// ── Supplier Payments ─────────────────────────────────────────────────────────

export const supplierPayments = pgTable('supplier_payments', {
  id:              uuid('id').primaryKey().defaultRandom(),
  orderId:         uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  userId:          uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId:        varchar('tenant_id',      { length: 36 }).notNull().default('system'),
  amount:          numeric('amount',         { precision: 12, scale: 2 }).notNull().default('0'),
  supplierId:      varchar('supplier_id',    { length: 255 }),
  supplierName:    varchar('supplier_name',  { length: 255 }),
  amountDue:       numeric('amount_due',     { precision: 12, scale: 2 }).notNull(),
  amountPaid:      numeric('amount_paid',    { precision: 12, scale: 2 }).default('0'),
  currency:        varchar('currency',       { length: 3 }).notNull().default('INR'),
  status:          supplierPaymentStatusEnum('status').notNull().default('pending'),
  paymentRef:      varchar('payment_ref',    { length: 255 }),
  paymentMethod:   varchar('payment_method', { length: 100 }),
  paidAt:          timestamp('paid_at',      { withTimezone: true }),
  notes:           text('notes'),
  createdAt:       timestamp('created_at',   { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at',   { withTimezone: true }).notNull().defaultNow(),
});

// ── Campaign Modes ────────────────────────────────────────────────────────────
// One row per campaign — records which mode was chosen and current phase.

export const campaignModes = pgTable('campaign_modes', {
  id:               uuid('id').primaryKey().defaultRandom(),
  campaignId:       uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  userId:           uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mode:             campaignModeEnum('mode').notNull().default('organic'),
  phase:            varchar('phase', { length: 50 }).notNull().default('organic'),  // organic | paid | scaling
  organicThreshold: numeric('organic_threshold', { precision: 7, scale: 4 }).default('0.03'),
  escalatedAt:      timestamp('escalated_at', { withTimezone: true }),
  paidBudgetInr:    numeric('paid_budget_inr', { precision: 12, scale: 2 }).default('0'),
  dailyCapInr:      numeric('daily_cap_inr',   { precision: 12, scale: 2 }).default('1000'),
  stopLossInr:      numeric('stop_loss_inr',   { precision: 12, scale: 2 }).default('5000'),
  isActive:         boolean('is_active').notNull().default(true),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
