/**
 * V62 Schema Extensions — Escrow, Fulfillment, Growth, Analytics
 *
 * Drizzle ORM table definitions for all V62 new tables.
 * Import alongside commerce/schema-extensions.ts where needed.
 */

import {
  pgTable, uuid, varchar, text, boolean,
  timestamp, numeric, integer, jsonb, pgEnum, char,
} from 'drizzle-orm/pg-core';
import { users, products, orders } from '../common/database/schema';

// ── Enums ──────────────────────────────────────────────────────────────────

export const escrowStatusEnum = pgEnum('escrow_status', [
  'PENDING_PAYMENT', 'PAYMENT_VERIFIED', 'ESCROW_CREATED',
  'AWAITING_SUPPLIER_PAYMENT', 'SUPPLIER_PAYMENT_PROCESSING',
  'SUPPLIER_PAID', 'SUPPLIER_FULFILLING', 'TRACKING_RECEIVED',
  'SHIPPED', 'DELIVERED', 'FAILED', 'REFUNDED',
]);

export const fulfillmentSupplierEnum = pgEnum('fulfillment_supplier', [
  'aliexpress', 'cjdropshipping', 'zendrop', 'autods', 'alibaba', 'custom',
]);

export const lifecycleSegmentEnum = pgEnum('lifecycle_segment', [
  'new_visitor', 'lead', 'first_purchase', 'repeat_buyer',
  'champion', 'at_risk', 'churned', 'win_back',
]);

export const lifecycleCampaignStatusEnum = pgEnum('lifecycle_campaign_status', [
  'queued', 'running', 'paused', 'completed', 'failed',
]);

export const growthEventTypeEnum = pgEnum('growth_event_type', [
  'referral_click', 'referral_convert', 'viral_share',
  'upsell_trigger', 'bundle_trigger', 'winback_trigger',
  'organic_escalate', 'growth_loop_complete',
]);

// ── Escrow Transactions ────────────────────────────────────────────────────

export const escrowTransactions = pgTable('escrow_transactions', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  tenantId:             uuid('tenant_id').notNull(),
  orderId:              uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  razorpayPaymentId:    varchar('razorpay_payment_id', { length: 128 }),
  razorpayOrderId:      varchar('razorpay_order_id', { length: 128 }),
  customerPaidAmount:   numeric('customer_paid_amount', { precision: 14, scale: 2 }).notNull(),
  razorpayFee:          numeric('razorpay_fee', { precision: 14, scale: 2 }).notNull().default('0'),
  supplierProductCost:  numeric('supplier_product_cost', { precision: 14, scale: 2 }).notNull().default('0'),
  supplierShippingCost: numeric('supplier_shipping_cost', { precision: 14, scale: 2 }).notNull().default('0'),
  taxAmount:            numeric('tax_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  adminCommission:      numeric('admin_commission', { precision: 14, scale: 2 }).notNull().default('0'),
  currency:             char('currency', { length: 3 }).notNull().default('INR'),
  status:               escrowStatusEnum('status').notNull().default('PENDING_PAYMENT'),
  paymentVerifiedAt:    timestamp('payment_verified_at', { withTimezone: true }),
  supplierPaidAt:       timestamp('supplier_paid_at', { withTimezone: true }),
  deliveredAt:          timestamp('delivered_at', { withTimezone: true }),
  refundedAt:           timestamp('refunded_at', { withTimezone: true }),
  refundReason:         text('refund_reason'),
  metadata:             jsonb('metadata').notNull().default({}),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Supplier Fulfillment Tasks ─────────────────────────────────────────────

export const supplierFulfillmentTasks = pgTable('supplier_fulfillment_tasks', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  tenantId:             uuid('tenant_id').notNull(),
  escrowId:             uuid('escrow_id').notNull().references(() => escrowTransactions.id),
  orderId:              uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  supplier:             fulfillmentSupplierEnum('supplier').notNull().default('aliexpress'),
  supplierProductUrl:   text('supplier_product_url'),
  supplierVariantId:    varchar('supplier_variant_id', { length: 255 }),
  checkoutAutofill:     jsonb('checkout_autofill').notNull().default({}),
  customerName:         varchar('customer_name', { length: 255 }),
  customerEmail:        varchar('customer_email', { length: 255 }),
  shippingAddress:      jsonb('shipping_address').notNull().default({}),
  quantity:             integer('quantity').notNull().default(1),
  supplierPrice:        numeric('supplier_price', { precision: 14, scale: 2 }),
  supplierShipping:     numeric('supplier_shipping', { precision: 14, scale: 2 }),
  supplierOrderId:      varchar('supplier_order_id', { length: 255 }),
  trackingNumber:       varchar('tracking_number', { length: 255 }),
  trackingCarrier:      varchar('tracking_carrier', { length: 100 }),
  trackingUrl:          text('tracking_url'),
  paymentProofUrl:      text('payment_proof_url'),
  status:               varchar('status', { length: 64 }).notNull().default('AWAITING_ADMIN'),
  adminNotes:           text('admin_notes'),
  processedByAdmin:     uuid('processed_by_admin'),
  processedAt:          timestamp('processed_at', { withTimezone: true }),
  markedPaidAt:         timestamp('marked_paid_at', { withTimezone: true }),
  trackingSyncedAt:     timestamp('tracking_synced_at', { withTimezone: true }),
  retryCount:           integer('retry_count').notNull().default(0),
  lastError:            text('last_error'),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Supplier Checkout Sessions ─────────────────────────────────────────────

export const supplierCheckoutSessions = pgTable('supplier_checkout_sessions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  fulfillmentId:  uuid('fulfillment_id').notNull().references(() => supplierFulfillmentTasks.id),
  supplier:       fulfillmentSupplierEnum('supplier').notNull(),
  checkoutUrl:    text('checkout_url').notNull(),
  autofillData:   jsonb('autofill_data').notNull().default({}),
  openedByAdmin:  uuid('opened_by_admin'),
  openedAt:       timestamp('opened_at', { withTimezone: true }),
  completedAt:    timestamp('completed_at', { withTimezone: true }),
  expiresAt:      timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Growth Loop Events ─────────────────────────────────────────────────────

export const growthLoopEvents = pgTable('growth_loop_events', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  tenantId:           uuid('tenant_id').notNull(),
  userId:             uuid('user_id').references(() => users.id),
  eventType:          growthEventTypeEnum('event_type').notNull(),
  sourceChannel:      varchar('source_channel', { length: 64 }),
  campaignId:         uuid('campaign_id'),
  productId:          uuid('product_id').references(() => products.id),
  attributedRevenue:  numeric('attributed_revenue', { precision: 14, scale: 2 }).notNull().default('0'),
  loopDepth:          integer('loop_depth').notNull().default(1),
  metadata:           jsonb('metadata').notNull().default({}),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Lifecycle Customer Segments ────────────────────────────────────────────

export const lifecycleCustomerSegments = pgTable('lifecycle_customer_segments', {
  id:                uuid('id').primaryKey().defaultRandom(),
  tenantId:          uuid('tenant_id').notNull(),
  customerEmail:     varchar('customer_email', { length: 255 }).notNull(),
  customerName:      varchar('customer_name', { length: 255 }),
  segment:           lifecycleSegmentEnum('segment').notNull().default('new_visitor'),
  totalOrders:       integer('total_orders').notNull().default(0),
  totalRevenue:      numeric('total_revenue', { precision: 14, scale: 2 }).notNull().default('0'),
  avgOrderValue:     numeric('avg_order_value', { precision: 14, scale: 2 }).notNull().default('0'),
  ltvScore:          numeric('ltv_score', { precision: 8, scale: 4 }).notNull().default('0'),
  churnRiskScore:    numeric('churn_risk_score', { precision: 5, scale: 4 }).notNull().default('0'),
  lastPurchaseAt:    timestamp('last_purchase_at', { withTimezone: true }),
  daysSincePurchase: integer('days_since_purchase'),
  rfmRecency:        integer('rfm_recency'),
  rfmFrequency:      integer('rfm_frequency'),
  rfmMonetary:       numeric('rfm_monetary', { precision: 14, scale: 2 }),
  predictedLtv90d:   numeric('predicted_ltv_90d', { precision: 14, scale: 2 }),
  tags:              text('tags').array().notNull().default([]),
  metadata:          jsonb('metadata').notNull().default({}),
  segmentedAt:       timestamp('segmented_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Lifecycle Campaigns ────────────────────────────────────────────────────

export const lifecycleCampaigns = pgTable('lifecycle_campaigns', {
  id:              uuid('id').primaryKey().defaultRandom(),
  tenantId:        uuid('tenant_id').notNull(),
  name:            varchar('name', { length: 255 }).notNull(),
  triggerSegment:  lifecycleSegmentEnum('trigger_segment').notNull(),
  triggerEvent:    varchar('trigger_event', { length: 64 }),
  channel:         varchar('channel', { length: 32 }).notNull().default('email'),
  subject:         text('subject'),
  bodyTemplate:    text('body_template').notNull(),
  ctaUrl:          text('cta_url'),
  delayHours:      integer('delay_hours').notNull().default(0),
  status:          lifecycleCampaignStatusEnum('status').notNull().default('queued'),
  sendsTotal:      integer('sends_total').notNull().default(0),
  opensTotal:      integer('opens_total').notNull().default(0),
  clicksTotal:     integer('clicks_total').notNull().default(0),
  conversions:     integer('conversions').notNull().default(0),
  revenueAttr:     numeric('revenue_attr', { precision: 14, scale: 2 }).notNull().default('0'),
  aiGenerated:     boolean('ai_generated').notNull().default(true),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Churn Predictions ─────────────────────────────────────────────────────

export const churnPredictions = pgTable('churn_predictions', {
  id:                uuid('id').primaryKey().defaultRandom(),
  tenantId:          uuid('tenant_id').notNull(),
  customerEmail:     varchar('customer_email', { length: 255 }).notNull(),
  churnScore:        numeric('churn_score', { precision: 5, scale: 4 }).notNull(),
  riskTier:          varchar('risk_tier', { length: 16 }).notNull(),
  topSignals:        jsonb('top_signals').notNull().default([]),
  recommendedAction: varchar('recommended_action', { length: 128 }),
  predictedAt:       timestamp('predicted_at', { withTimezone: true }).notNull().defaultNow(),
  actionedAt:        timestamp('actioned_at', { withTimezone: true }),
});

// ── Revenue Optimization Rules ─────────────────────────────────────────────

export const revenueOptimizationRules = pgTable('revenue_optimization_rules', {
  id:              uuid('id').primaryKey().defaultRandom(),
  tenantId:        uuid('tenant_id').notNull(),
  ruleType:        varchar('rule_type', { length: 64 }).notNull(),
  triggerContext:  jsonb('trigger_context').notNull().default({}),
  actionConfig:    jsonb('action_config').notNull().default({}),
  priority:        integer('priority').notNull().default(100),
  active:          boolean('active').notNull().default(true),
  abVariant:       varchar('ab_variant', { length: 8 }),
  conversionRate:  numeric('conversion_rate', { precision: 6, scale: 4 }).notNull().default('0'),
  revenueLift:     numeric('revenue_lift', { precision: 14, scale: 2 }).notNull().default('0'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Commerce KPI Snapshots ─────────────────────────────────────────────────

export const commerceKpiSnapshots = pgTable('commerce_kpi_snapshots', {
  id:               uuid('id').primaryKey().defaultRandom(),
  tenantId:         uuid('tenant_id').notNull(),
  snapshotAt:       timestamp('snapshot_at', { withTimezone: true }).notNull().defaultNow(),
  period:           varchar('period', { length: 16 }).notNull().default('hourly'),
  roas:             numeric('roas', { precision: 8, scale: 4 }),
  cac:              numeric('cac', { precision: 10, scale: 2 }),
  ltv30d:           numeric('ltv_30d', { precision: 10, scale: 2 }),
  ltv90d:           numeric('ltv_90d', { precision: 10, scale: 2 }),
  ctr:              numeric('ctr', { precision: 6, scale: 4 }),
  conversionRate:   numeric('conversion_rate', { precision: 6, scale: 4 }),
  aov:              numeric('aov', { precision: 10, scale: 2 }),
  grossRevenue:     numeric('gross_revenue', { precision: 14, scale: 2 }),
  netProfit:        numeric('net_profit', { precision: 14, scale: 2 }),
  adSpend:          numeric('ad_spend', { precision: 14, scale: 2 }),
  ordersCount:      integer('orders_count'),
  newCustomers:     integer('new_customers'),
  repeatCustomers:  integer('repeat_customers'),
  churnRate:        numeric('churn_rate', { precision: 6, scale: 4 }),
  viralityScore:    numeric('virality_score', { precision: 6, scale: 4 }),
  metadata:         jsonb('metadata').notNull().default({}),
});
