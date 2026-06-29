/**
 * WithdrawalSchema — Production Payment Architecture
 *
 * Tables:
 *   withdrawals          — Manual admin-controlled withdrawal requests
 *   withdrawal_bank_details — AES-256-GCM encrypted bank credentials
 *   platform_finance_snapshots — Daily P&L snapshots per tenant
 *
 * SECURITY RULES:
 *   - Bank account numbers, IFSC codes, holder names are AES-encrypted at rest
 *   - ciphertext fields are NEVER returned in list/summary queries
 *   - Decryption happens ONLY during admin payout review
 *   - tenant_id enforced on ALL rows — no cross-tenant leakage
 *
 * Withdrawal lifecycle:
 *   pending → approved → completed
 *             ↓
 *           rejected (terminal)
 *
 * Fraud safeguards:
 *   - is_frozen flag blocks all actions without admin override
 *   - pending_orders_count cached at request time for fraud gating
 *   - admin_notes mandatory on rejection
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
import { users } from '../common/database/schema';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const withdrawalStatusEnum = pgEnum('withdrawal_status', [
  'pending',
  'approved',
  'rejected',
  'completed',
]);

export const subscriptionPlanEnum = pgEnum('subscription_plan', [
  'free',
  'pro',
  'elite',
]);

export const razorpayEventEnum = pgEnum('razorpay_event', [
  'subscription.created',
  'subscription.activated',
  'subscription.charged',
  'subscription.cancelled',
  'payment.failed',
]);

// ── Withdrawals ───────────────────────────────────────────────────────────────

export const withdrawals = pgTable('withdrawals', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id').notNull(),
  userId:   uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  amount:   numeric('amount', { precision: 14, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull().default('INR'),

  status: withdrawalStatusEnum('status').notNull().default('pending'),

  // Denormalized for fraud checks — cached at request time
  bankName: varchar('bank_name', { length: 255 }).notNull(),

  // AES-256-GCM encrypted fields — NEVER logged or returned unencrypted
  accountHolderNameCiphertext: text('account_holder_name_ciphertext').notNull(),
  accountHolderNameIv:         text('account_holder_name_iv').notNull(),
  accountHolderNameTag:        text('account_holder_name_tag').notNull(),

  accountNumberCiphertext: text('account_number_ciphertext').notNull(),
  accountNumberIv:         text('account_number_iv').notNull(),
  accountNumberTag:        text('account_number_tag').notNull(),

  ifscCodeCiphertext: text('ifsc_code_ciphertext').notNull(),
  ifscCodeIv:         text('ifsc_code_iv').notNull(),
  ifscCodeTag:        text('ifsc_code_tag').notNull(),

  // Fraud gate — number of pending supplier-unpaid orders at request time
  pendingOrdersAtRequest: integer('pending_orders_at_request').notNull().default(0),

  // Admin workflow
  adminNotes:   text('admin_notes'),
  reviewedBy:   uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  isFrozen:     boolean('is_frozen').notNull().default(false),
  frozenReason: text('frozen_reason'),

  // Razorpay payout reference (when admin uses Razorpay X for transfer)
  razorpayPayoutId: varchar('razorpay_payout_id', { length: 255 }),

  createdAt:   timestamp('created_at',   { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  updatedAt:   timestamp('updated_at',   { withTimezone: true }).notNull().defaultNow(),
});

// ── Platform Finance Snapshots ────────────────────────────────────────────────
// Daily P&L snapshots — append-only, never updated

export const platformFinanceSnapshots = pgTable('platform_finance_snapshots', {
  id:       uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),

  snapshotDate: timestamp('snapshot_date', { withTimezone: true }).notNull(),

  totalRevenue:        numeric('total_revenue',         { precision: 16, scale: 2 }).notNull().default('0'),
  supplierCosts:       numeric('supplier_costs',        { precision: 16, scale: 2 }).notNull().default('0'),
  platformCommissions: numeric('platform_commissions',  { precision: 16, scale: 2 }).notNull().default('0'),
  adSpend:             numeric('ad_spend',              { precision: 16, scale: 2 }).notNull().default('0'),
  estimatedNetProfit:  numeric('estimated_net_profit',  { precision: 16, scale: 2 }).notNull().default('0'),

  fulfilledOrders:  integer('fulfilled_orders').notNull().default(0),
  pendingOrders:    integer('pending_orders').notNull().default(0),
  totalOrders:      integer('total_orders').notNull().default(0),

  totalWithdrawn:  numeric('total_withdrawn',  { precision: 16, scale: 2 }).notNull().default('0'),
  pendingPayouts:  numeric('pending_payouts',  { precision: 16, scale: 2 }).notNull().default('0'),

  subscriptionRevenue: numeric('subscription_revenue', { precision: 16, scale: 2 }).notNull().default('0'),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Subscription Plans ────────────────────────────────────────────────────────

export const userSubscriptions = pgTable('user_subscriptions', {
  id:       uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId:   uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

  plan:   subscriptionPlanEnum('plan').notNull().default('free'),
  status: varchar('status', { length: 50 }).notNull().default('active'),

  // Razorpay identifiers — platform Razorpay account only
  razorpayCustomerId:       varchar('razorpay_customer_id',       { length: 255 }),
  razorpaySubscriptionId:   varchar('razorpay_subscription_id',   { length: 255 }),
  razorpayPlanId:           varchar('razorpay_plan_id',           { length: 255 }),

  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd:   timestamp('current_period_end',   { withTimezone: true }),
  cancelAtPeriodEnd:  boolean('cancel_at_period_end').notNull().default(false),

  // Plan limits
  maxBots:           integer('max_bots').notNull().default(1),
  adsEnabled:        boolean('ads_enabled').notNull().default(false),
  advancedAutomation: boolean('advanced_automation').notNull().default(false),

  monthlyAmountInr: numeric('monthly_amount_inr', { precision: 12, scale: 2 }).notNull().default('0'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Razorpay Webhook Events ───────────────────────────────────────────────────
// Idempotency store for Razorpay webhooks

export const razorpayWebhookEvents = pgTable('razorpay_webhook_events', {
  id:          uuid('id').primaryKey().defaultRandom(),
  eventId:     varchar('event_id',   { length: 255 }).notNull().unique(), // Razorpay event ID
  eventType:   varchar('event_type', { length: 100 }).notNull(),
  payload:     jsonb('payload').notNull(),
  processed:   boolean('processed').notNull().default(false),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error:       text('error'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
