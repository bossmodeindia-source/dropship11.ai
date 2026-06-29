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
  bigserial,
  bigint,
  doublePrecision,
  inet,
  char,
  pgEnum,
} from 'drizzle-orm/pg-core';

// ── Enums ────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum('user_role', ['user', 'admin', 'superadmin']);
export const subscriptionTierEnum = pgEnum('subscription_tier', ['free', 'starter', 'pro', 'enterprise']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'trialing', 'past_due', 'canceled', 'paused']);
export const productDecisionEnum = pgEnum('product_decision', ['RUN_ADS', 'TEST_ADS', 'REJECT', 'PENDING']);
export const productStatusEnum = pgEnum('product_status', ['pending', 'scored', 'listed', 'archived']);
export const orderStatusEnum = pgEnum('order_status', [
  'received', 'queued', 'processing', 'supplier_submitted',
  'supplier_confirmed', 'shipped', 'delivered', 'failed', 'refunded',
]);
export const aiModeEnum = pgEnum('ai_mode', ['AI', 'BOT']);
export const auditActionEnum = pgEnum('audit_action', [
  'user.created', 'user.updated', 'user.suspended', 'user.deleted',
  'product.scored', 'product.rejected', 'product.listed',
  'order.received', 'order.fulfilled', 'order.failed',
  'campaign.generated', 'subscription.changed', 'auth.login', 'auth.logout',
  'admin.action',
]);
export const metaAdStatusEnum = pgEnum('meta_ad_status', [
  'draft', 'pending', 'active', 'paused', 'error',
]);
export const campaignPerformanceStatusEnum = pgEnum('campaign_performance_status', [
  'poor', 'average', 'good',
  'profitable', 'break_even', 'loss',
  'unknown',
]);

// ── Users ────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role:         userRoleEnum('role').notNull().default('user'),
  fullName:     varchar('full_name', { length: 255 }),
  companyName:  varchar('company_name', { length: 255 }),
  aiMode:       aiModeEnum('ai_mode').notNull().default('BOT'),
  isActive:     boolean('is_active').notNull().default(true),
  isVerified:   boolean('is_verified').notNull().default(false),
  lastLoginAt:  timestamp('last_login_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Refresh Tokens ───────────────────────────────────────────────────
export const refreshTokens = pgTable('refresh_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash:  text('token_hash').notNull().unique(),
  expiresAt:  timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked:    boolean('revoked').notNull().default(false),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Subscriptions ────────────────────────────────────────────────────
export const subscriptions = pgTable('subscriptions', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  userId:             uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  tier:               subscriptionTierEnum('tier').notNull().default('free'),
  status:             subscriptionStatusEnum('status').notNull().default('active'),
  externalCustomerId: varchar('external_customer_id', { length: 255 }),
  externalSubId:      varchar('external_sub_id', { length: 255 }),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd:   timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd:  boolean('cancel_at_period_end').notNull().default(false),
  productLimit:       integer('product_limit').notNull().default(10),
  orderLimit:         integer('order_limit').notNull().default(50),
  aiRequestsLimit:    integer('ai_requests_limit').notNull().default(0),
  aiRequestsUsed:     integer('ai_requests_used').notNull().default(0),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Shopify API Keys ──────────────────────────────────────────────────
export const shopifyApiKeys = pgTable('shopify_api_keys', {
  id:            uuid('id').primaryKey().defaultRandom(),
  userId:        uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  shopDomain:    varchar('shop_domain', { length: 255 }).notNull(),
  accessToken:   text('access_token').notNull(),
  webhookSecret: text('webhook_secret'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Products ─────────────────────────────────────────────────────────
export const products = pgTable('products', {
  id:               uuid('id').primaryKey().defaultRandom(),
  userId:           uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  externalId:       varchar('external_id', { length: 255 }),
  supplierType:     varchar('supplier_type', { length: 50 }).notNull().default('mock'),
  title:            text('title').notNull(),
  description:      text('description'),
  supplierPrice:    numeric('supplier_price', { precision: 12, scale: 2 }).notNull(),
  sellingPrice:     numeric('selling_price', { precision: 12, scale: 2 }),
  currency:         char('currency', { length: 3 }).notNull().default('USD'),
  imageUrls:        text('image_urls').array().notNull().default([]),
  category:         varchar('category', { length: 100 }),
  tags:             text('tags').array().notNull().default([]),
  demandScore:      numeric('demand_score', { precision: 5, scale: 2 }),
  competitionScore: numeric('competition_score', { precision: 5, scale: 2 }),
  marginScore:      numeric('margin_score', { precision: 5, scale: 2 }),
  trendIndex:       numeric('trend_index', { precision: 5, scale: 2 }),
  compositeScore:   numeric('composite_score', { precision: 5, scale: 2 }),
  decision:         productDecisionEnum('decision').notNull().default('PENDING'),
  decisionReason:   text('decision_reason'),
  status:           productStatusEnum('status').notNull().default('pending'),
  shopifyProductId: varchar('shopify_product_id', { length: 255 }),
  // V44 source tracking
  sourceUrl:        text('source_url'),
  v44SupplierId:    varchar('v44_supplier_id', { length: 255 }),
  supplierPayload:  jsonb('supplier_payload').default({}),
  backupSuppliers:  jsonb('backup_suppliers').default([]),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  scoredAt:         timestamp('scored_at', { withTimezone: true }),
  listedAt:         timestamp('listed_at', { withTimezone: true }),
});

// ── Orders ───────────────────────────────────────────────────────────
export const orders = pgTable('orders', {
  id:               uuid('id').primaryKey().defaultRandom(),
  userId:           uuid('user_id').notNull().references(() => users.id),
  productId:        uuid('product_id').references(() => products.id),
  idempotencyKey:   varchar('idempotency_key', { length: 255 }).notNull().unique(),
  platformOrderId:  varchar('platform_order_id', { length: 255 }).notNull(),
  platform:         varchar('platform', { length: 50 }).notNull().default('shopify'),
  customerName:     varchar('customer_name', { length: 255 }),
  customerEmail:    varchar('customer_email', { length: 255 }),
  shippingAddress:  jsonb('shipping_address').notNull().default({}),
  quantity:         integer('quantity').notNull().default(1),
  unitPrice:        numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  totalAmount:      numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
  currency:         char('currency', { length: 3 }).notNull().default('USD'),
  status:           orderStatusEnum('status').notNull().default('received'),
  supplierType:     varchar('supplier_type', { length: 50 }),
  supplierOrderId:  varchar('supplier_order_id', { length: 255 }),
  trackingNumber:   varchar('tracking_number', { length: 255 }),
  trackingUrl:      text('tracking_url'),
  supplierResponse: jsonb('supplier_response'),
  retryCount:       integer('retry_count').notNull().default(0),
  lastError:        text('last_error'),
  rawPayload:       jsonb('raw_payload').notNull().default({}),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  fulfilledAt:      timestamp('fulfilled_at', { withTimezone: true }),
  deliveredAt:      timestamp('delivered_at', { withTimezone: true }),
});

// ── Order Status Log ─────────────────────────────────────────────────
export const orderStatusLog = pgTable('order_status_log', {
  id:         bigserial('id', { mode: 'number' }).primaryKey(),
  orderId:    uuid('order_id').notNull().references(() => orders.id),
  fromStatus: orderStatusEnum('from_status'),
  toStatus:   orderStatusEnum('to_status').notNull(),
  metadata:   jsonb('metadata').notNull().default({}),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Campaigns ────────────────────────────────────────────────────────
export const campaigns = pgTable('campaigns', {
  id:             uuid('id').primaryKey().defaultRandom(),
  userId:         uuid('user_id').notNull().references(() => users.id),
  productId:      uuid('product_id').notNull().references(() => products.id),
  platform:       varchar('platform', { length: 50 }).notNull(),
  name:           text('name').notNull(),
  objective:      varchar('objective', { length: 100 }),
  targetAudience: jsonb('target_audience').notNull().default({}),
  budgetDaily:    numeric('budget_daily', { precision: 10, scale: 2 }),
  budgetTotal:    numeric('budget_total', { precision: 10, scale: 2 }),
  adCopy:         jsonb('ad_copy').notNull().default({}),
  keywords:       text('keywords').array().notNull().default([]),
  status:         varchar('status', { length: 50 }).notNull().default('draft'),
  externalId:     varchar('external_id', { length: 255 }),
  aiGenerated:    boolean('ai_generated').notNull().default(false),
  impressions:    integer('impressions'),
  clicks:         integer('clicks'),
  conversions:    integer('conversions'),
  ctr:            numeric('ctr',  { precision: 8,  scale: 4 }),
  cpc:            numeric('cpc',  { precision: 10, scale: 4 }),
  roas:           numeric('roas', { precision: 10, scale: 4 }),
  performanceStatus: campaignPerformanceStatusEnum('performance_status')
                       .notNull()
                       .default('unknown'),
  // V17: Added by v17-audit-fixes.sql migration — required for RCCS kernel event sequencer
  adsetId:        varchar('adset_id', { length: 255 }),
  eventVersion:   integer('event_version').notNull().default(1),
  // V17: Landing page flags (added in v3/v4 migration)
  lpFlag:         boolean('lp_flag').default(false),
  lpFlagReason:   jsonb('lp_flag_reason'),
  lpFlaggedAt:    timestamp('lp_flagged_at', { withTimezone: true }),
  // V17: Score columns used by profit engine
  v3PredictionScore: numeric('v3_prediction_score', { precision: 6, scale: 3 }),
  v3PredictionLabel: varchar('v3_prediction_label', { length: 50 }),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Meta Ad Sets ─────────────────────────────────────────────────────
export const metaAdSets = pgTable('meta_adsets', {
  id:               uuid('id').primaryKey().defaultRandom(),
  campaignId:       uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  userId:           uuid('user_id').notNull().references(() => users.id),
  productId:        uuid('product_id').notNull().references(() => products.id),
  name:             text('name').notNull(),
  targeting:        jsonb('targeting').notNull().default({}),
  budgetDaily:      numeric('budget_daily', { precision: 10, scale: 2 }).notNull(),
  billingEvent:     varchar('billing_event', { length: 50 }).notNull().default('IMPRESSIONS'),
  optimizationGoal: varchar('optimization_goal', { length: 100 }).notNull(),
  status:           metaAdStatusEnum('status').notNull().default('draft'),
  externalId:       varchar('external_id', { length: 255 }),
  errorMessage:     text('error_message'),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Meta Ad Creatives ─────────────────────────────────────────────────
export const metaAdCreatives = pgTable('meta_ad_creatives', {
  id:           uuid('id').primaryKey().defaultRandom(),
  adSetId:      uuid('adset_id').notNull().references(() => metaAdSets.id, { onDelete: 'cascade' }),
  campaignId:   uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  userId:       uuid('user_id').notNull().references(() => users.id),
  productId:    uuid('product_id').notNull().references(() => products.id),
  name:         text('name').notNull(),
  headline:     text('headline').notNull(),
  body:         text('body').notNull(),
  cta:          varchar('cta', { length: 100 }).notNull().default('SHOP_NOW'),
  imageUrl:     text('image_url'),
  linkUrl:      text('link_url'),
  status:       metaAdStatusEnum('status').notNull().default('draft'),
  externalId:   varchar('external_id', { length: 255 }),
  errorMessage: text('error_message'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Audit Logs ───────────────────────────────────────────────────────
export const auditLogs = pgTable('audit_logs', {
  id:         bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId:   text('tenant_id'),
  actorId:    uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  // TEXT not pgEnum — AuditService writes free-form action strings
  action:     text('action').notNull(),
  resource:   text('resource'),
  resourceId: text('resource_id'),
  details:    jsonb('details'),
  severity:   text('severity').notNull().default('info'),
  ipAddress:  inet('ip_address'),
  userAgent:  text('user_agent'),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── AI Usage Logs ────────────────────────────────────────────────────
export const aiUsageLogs = pgTable('ai_usage_logs', {
  id:               bigserial('id', { mode: 'number' }).primaryKey(),
  userId:           uuid('user_id').notNull().references(() => users.id),
  operation:        varchar('operation', { length: 100 }).notNull(),
  model:            varchar('model', { length: 100 }).notNull(),
  promptTokens:     integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  totalTokens:      integer('total_tokens').notNull().default(0),
  costUsd:          numeric('cost_usd', { precision: 10, scale: 6 }),
  latencyMs:        integer('latency_ms'),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Ad Creative Assets ────────────────────────────────────────────────────────
export const adCreativeAssets = pgTable('ad_creative_assets', {
  id:          uuid('id').primaryKey().defaultRandom(),
  productId:   uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  userId:      uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  campaignId:  uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  hooks:       text('hooks').array().notNull().default([]),
  captions:    text('captions').array().notNull().default([]),
  headlines:   text('headlines').array().notNull().default([]),
  videoScript: jsonb('video_script').notNull().default({}),
  aiGenerated: boolean('ai_generated').notNull().default(false),
  model:       varchar('model', { length: 100 }).notNull().default('template'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Ad Media Assets ───────────────────────────────────────────────────────────
// Caching table: one row per unique prompt_hash. Re-used assets increment
// use_count instead of triggering a new (costly) API generation call.
// Performance tracked via generation_time_ms and success fields.
export const adMediaAssets = pgTable('ad_media_assets', {
  id:               uuid('id').primaryKey().defaultRandom(),
  productId:        uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  campaignId:       uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  imageUrl:         text('image_url'),
  videoUrl:         text('video_url'),
  promptHash:       varchar('prompt_hash', { length: 64 }).notNull(),
  provider:         varchar('provider', { length: 100 }).notNull().default('open-generative-ai'),
  generationTimeMs: integer('generation_time_ms'),
  success:          boolean('success').notNull().default(true),
  useCount:         integer('use_count').notNull().default(1),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// V2 AI INFRASTRUCTURE TABLES
// ─────────────────────────────────────────────────────────────────────────────

// ── Semantic Cache (L2 — PostgreSQL) ─────────────────────────────────────────
// Cross-user shared cache for AI responses. L1 lives in Redis.
// Key: SHA256(normalised operation + category + title_bucket + price_bucket)
export const aiCache = pgTable('ai_cache', {
  id:         uuid('id').primaryKey().defaultRandom(),
  cacheKey:   varchar('cache_key', { length: 64 }).notNull().unique(),  // SHA256 hex
  operation:  varchar('operation', { length: 50 }).notNull(),
  category:   varchar('category', { length: 100 }),
  content:    jsonb('content').notNull(),
  hitCount:   integer('hit_count').notNull().default(1),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastHitAt:  timestamp('last_hit_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt:  timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ── AI Memory (self-learning pattern store) ───────────────────────────────────
// Winning creative patterns harvested by FeedbackProcessor every 60 minutes.
// Top-3 patterns injected into every NVIDIA prompt for the same category.
// performance_score = CTR×0.4 + ROAS×0.6
export const aiMemory = pgTable('ai_memory', {
  id:               uuid('id').primaryKey().defaultRandom(),
  operation:        varchar('operation', { length: 50 }).notNull(),
  category:         varchar('category', { length: 100 }).notNull(),
  hook:             text('hook'),
  headline:         text('headline'),
  caption:          text('caption'),
  ctr:              numeric('ctr',  { precision: 5, scale: 3 }),
  roas:             numeric('roas', { precision: 7, scale: 3 }),
  performanceScore: numeric('performance_score', { precision: 5, scale: 3 }).notNull(),
  sourceCampaign:   uuid('source_campaign').references(() => campaigns.id, { onDelete: 'set null' }),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── AI Job Results (async job tracking) ───────────────────────────────────────
// Every async AI job (listing, campaign, media) writes its result here.
// HTTP clients receive jobId immediately (202) and poll this table.
export const aiJobResults = pgTable('ai_job_results', {
  id:          uuid('id').primaryKey().defaultRandom(),
  jobId:       varchar('job_id', { length: 128 }).notNull().unique(),
  queue:       varchar('queue', { length: 50 }).notNull(),
  operation:   varchar('operation', { length: 50 }).notNull(),
  userId:      uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status:      varchar('status', { length: 20 }).notNull().default('pending'),
  result:      jsonb('result'),
  error:       text('error'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// ── API Keys (admin-injected, AES-256-GCM encrypted at rest) ─────────────────
// Managed exclusively via ConfigVaultService. Never expose raw values.
// Source: 'env' = loaded from environment, 'admin' = injected via admin API.
export const apiKeys = pgTable('api_keys', {
  id:             uuid('id').primaryKey().defaultRandom(),
  keyName:        varchar('key_name', { length: 100 }).notNull().unique(),
  encryptedValue: text('encrypted_value').notNull(),
  source:         varchar('source', { length: 20 }).notNull().default('admin'),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Campaign Metrics (performance data for FeedbackProcessor) ─────────────────
// Updated by Meta Ads webhook. Used by FeedbackProcessor to harvest winning patterns.
export const campaignMetrics = pgTable('campaign_metrics', {
  id:          uuid('id').primaryKey().defaultRandom(),
  campaignId:  uuid('campaign_id').notNull().unique().references(() => campaigns.id, { onDelete: 'cascade' }),
  impressions: integer('impressions').notNull().default(0),
  clicks:      integer('clicks').notNull().default(0),
  ctr:         numeric('ctr',      { precision: 7, scale: 4 }),
  roas:        numeric('roas',     { precision: 10, scale: 4 }),
  spendUsd:    numeric('spend_usd', { precision: 12, scale: 2 }),
  conversions: integer('conversions').notNull().default(0),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── DLQ Events (dead-letter queue audit log) ──────────────────────────────────
// Written by DlqEventsRepository when orders exhaust all retry attempts.
// Allows ops to query + replay permanently failed orders.
export const dlqEvents = pgTable('dlq_events', {
  id:              uuid('id').primaryKey().defaultRandom(),
  orderId:         varchar('order_id',          { length: 255 }).notNull(),
  userId:          uuid('user_id'),
  platformOrderId: varchar('platform_order_id', { length: 255 }),
  supplierType:    varchar('supplier_type',      { length: 50 }),
  jobId:           varchar('job_id',             { length: 255 }),
  attemptsMade:    integer('attempts_made').notNull().default(0),
  failureReason:   text('failure_reason'),
  alerted:         boolean('alerted').notNull().default(false),
  alertedAt:       timestamp('alerted_at',  { withTimezone: true }),
  createdAt:       timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
});

// ══════════════════════════════════════════════════════════════════════════════
// V60 ENTERPRISE STABILIZATION — NEW TABLES
// Required by: UnifiedFinanceEngine, UnifiedCommerceOrchestrator
// ══════════════════════════════════════════════════════════════════════════════

// ── Commerce Cycles (UnifiedCommerceOrchestrator state persistence) ───────────
// Every commerce cycle writes state here. Used for crash recovery on restart.
export const commerceCycles = pgTable('commerce_cycles', {
  id:        varchar('id', { length: 36 }).primaryKey(), // UUID
  botId:     varchar('bot_id',    { length: 36 }).notNull(),
  tenantId:  varchar('tenant_id', { length: 36 }).notNull(),
  status:    varchar('status', { length: 20 }).notNull().default('running'),
  // 'running' | 'completed' | 'failed' | 'paused'
  steps:     text('steps').notNull().default('{}'),          // JSON blob
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Revenue Events (UnifiedFinanceEngine — idempotent revenue recording) ──────
// orderId is the idempotency key. Duplicate inserts are silently ignored.
// adminCommission is INTERNAL — never expose to user-facing APIs.
export const revenueEvents = pgTable('revenue_events', {
  id:              varchar('id', { length: 100 }).primaryKey(), // 'rev:{orderId}'
  tenantId:        varchar('tenant_id',        { length: 36  }).notNull(),
  botId:           varchar('bot_id',           { length: 36  }).notNull(),
  orderId:         varchar('order_id',         { length: 100 }).notNull().unique(),
  shopifyOrderId:  varchar('shopify_order_id', { length: 100 }),
  grossRevenue:    numeric('gross_revenue',    { precision: 14, scale: 2 }).notNull(),
  adminCommission: numeric('admin_commission', { precision: 14, scale: 2 }).notNull().default('0'),
  netRevenue:      numeric('net_revenue',      { precision: 14, scale: 2 }).notNull(),
  currency:        varchar('currency',         { length: 10  }).notNull().default('INR'),
  productId:       varchar('product_id',       { length: 100 }),
  cycleId:         varchar('cycle_id',         { length: 36  }),
  recordedAt:      timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Cost Events (UnifiedFinanceEngine — idempotent cost recording) ────────────
// cycleId or campaignId is the idempotency key.
export const costEvents = pgTable('cost_events', {
  id:           varchar('id', { length: 100 }).primaryKey(), // 'cost:{cycleId|campaignId}'
  tenantId:     varchar('tenant_id',  { length: 36  }).notNull(),
  botId:        varchar('bot_id',     { length: 36  }).notNull(),
  campaignId:   varchar('campaign_id', { length: 100 }),
  cycleId:      varchar('cycle_id',   { length: 36  }),
  adSpend:      numeric('ad_spend',       { precision: 14, scale: 2 }).notNull().default('0'),
  supplierCost: numeric('supplier_cost',  { precision: 14, scale: 2 }).notNull().default('0'),
  platformFees: numeric('platform_fees',  { precision: 14, scale: 2 }).notNull().default('0'),
  totalCost:    numeric('total_cost',     { precision: 14, scale: 2 }).notNull().default('0'),
  currency:     varchar('currency', { length: 10 }).notNull().default('INR'),
  recordedAt:   timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Commission Configs (admin-only — NEVER expose to users) ──────────────────
// Per-tenant commission configuration. Defaults: 15% rate, 0 flat minimum.
export const commissionConfigs = pgTable('commission_configs', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tenantId:       varchar('tenant_id', { length: 36 }).notNull().unique(),
  commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull().default('0.15'),
  // e.g. 0.15 = 15%
  minimumFlat:    numeric('minimum_flat',    { precision: 14, scale: 2 }).notNull().default('0'),
  currency:       varchar('currency', { length: 10 }).notNull().default('INR'),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Withdrawals ──────────────────────────────────────────────────────────────
export const withdrawals = pgTable('withdrawals', {
  id:             uuid('id').primaryKey().defaultRandom(),
  userId:         uuid('user_id').notNull().references(() => users.id),
  tenantId:       varchar('tenant_id',   { length: 36 }).notNull(),
  amount:         numeric('amount',      { precision: 14, scale: 2 }).notNull(),
  currency:       varchar('currency',    { length: 10 }).notNull().default('INR'),
  status:         varchar('status',      { length: 30 }).notNull().default('pending'),
  bankName:       varchar('bank_name',   { length: 120 }),
  accountNumber:  text('account_number'),
  ifscCode:       varchar('ifsc_code',   { length: 20 }),
  upiId:          varchar('upi_id',      { length: 120 }),
  rejectionReason: text('rejection_reason'),
  processedAt:    timestamp('processed_at',  { withTimezone: true }),
  createdAt:      timestamp('created_at',    { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at',    { withTimezone: true }).notNull().defaultNow(),
});

// ── Bots ─────────────────────────────────────────────────────────────────────
export const bots = pgTable('bots', {
  id:               uuid('id').primaryKey().defaultRandom(),
  userId:           uuid('user_id').notNull().references(() => users.id),
  name:             varchar('name',          { length: 120 }).notNull(),
  mode:             varchar('mode',          { length: 30 }).notNull().default('STANDARD'),
  status:           varchar('status',        { length: 30 }).notNull().default('idle'),
  engineVersion:    varchar('engine_version',{ length: 20 }).notNull().default('v60'),
  priority:         integer('priority').notNull().default(5),
  isActive:         boolean('is_active').notNull().default(true),
  lastScheduledAt:  timestamp('last_scheduled_at', { withTimezone: true }),
  suspendedReason:  text('suspended_reason'),
  lastOutput:       jsonb('last_output'),
  config:           jsonb('config').notNull().default({}),
  lastRunAt:        timestamp('last_run_at',  { withTimezone: true }),
  lastExecutedAt:   timestamp('last_executed_at', { withTimezone: true }),
  createdAt:        timestamp('created_at',   { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at',   { withTimezone: true }).notNull().defaultNow(),
});

// ── Bot Job Records ───────────────────────────────────────────────────────────
export const botJobRecords = pgTable('bot_job_records', {
  id:            uuid('id').primaryKey().defaultRandom(),
  jobId:         varchar('job_id', { length: 120 }),       // Bull queue job ID
  botId:         uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
  userId:        uuid('user_id').notNull().references(() => users.id),
  tenantId:      varchar('tenant_id', { length: 36 }).notNull().default('system'),
  jobType:       varchar('job_type',  { length: 60 }).notNull(),
  executionType: varchar('execution_type', { length: 60 }),
  status:        varchar('status',    { length: 30 }).notNull().default('queued'),
  input:         jsonb('input').default({}),
  output:        jsonb('output'),
  errorMsg:      text('error_msg'),
  startedAt:     timestamp('started_at',   { withTimezone: true }),
  completedAt:   timestamp('completed_at', { withTimezone: true }),
  createdAt:     timestamp('created_at',   { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at',   { withTimezone: true }).notNull().defaultNow(),
});

// ── Bot Execution Results ─────────────────────────────────────────────────────
export const botExecutionResults = pgTable('bot_execution_results', {
  id:          uuid('id').primaryKey().defaultRandom(),
  jobRecordId: uuid('job_record_id').notNull().references(() => botJobRecords.id, { onDelete: 'cascade' }),
  botId:       uuid('bot_id').notNull().references(() => bots.id),
  decision:    varchar('decision', { length: 30 }).notNull(),
  payload:     jsonb('payload').default({}),
  executedAt:  timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── V44 Schema (merged from v44-schema.ts — V66 single source of truth) ──────
// V66 Medium Fix #4: v44-schema.ts content merged here. v44-schema.ts is now
// a compatibility re-export only. All new code references schema.ts directly.

// ── V44 Orders ────────────────────────────────────────────────────────────────
export const v44Orders = pgTable('v44_orders', {
  id:              uuid('id').primaryKey().defaultRandom(),
  storeId:         uuid('store_id').notNull().references(() => users.id,    { onDelete: 'restrict', onUpdate: 'cascade' }),
  productId:       uuid('product_id').references(() => products.id,         { onDelete: 'set null',  onUpdate: 'cascade' }),
  productName:     text('product_name').notNull(),
  quantity:        integer('quantity').notNull().default(1),
  sellingPrice:    numeric('selling_price', { precision: 12, scale: 2 }).notNull(),
  costPrice:       numeric('cost_price',    { precision: 12, scale: 2 }),
  profit:          numeric('profit',        { precision: 12, scale: 2 }),
  customerName:    text('customer_name'),
  customerPhone:   varchar('customer_phone',  { length: 20 }),
  customerAddress: text('customer_address'),
  customerCity:    varchar('customer_city',   { length: 100 }),
  customerPincode: varchar('customer_pincode',{ length: 20 }),
  customerEmail:   varchar('customer_email',  { length: 255 }),
  shippingAddress: jsonb('shipping_address').notNull().default({}),
  sourceType:      varchar('source_type', { length: 50 }),
  paymentStatus:   varchar('payment_status', { length: 20 }).notNull().default('unpaid'),
  orderStatus:     varchar('order_status',   { length: 50 }).notNull().default('pending_payment'),
  platform:        varchar('platform', { length: 50 }).notNull().default('shopify'),
  platformOrderId: varchar('platform_order_id', { length: 255 }),
  idempotencyKey:  varchar('idempotency_key', { length: 255 }).unique(),
  notes:           text('notes'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── V44 Order Items ───────────────────────────────────────────────────────────
export const v44OrderItems = pgTable('v44_order_items', {
  id:          uuid('id').primaryKey().defaultRandom(),
  orderId:     uuid('order_id').notNull().references(() => v44Orders.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  productId:   uuid('product_id').references(() => products.id,          { onDelete: 'set null', onUpdate: 'cascade' }),
  productName: text('product_name').notNull(),
  sku:         varchar('sku', { length: 255 }),
  quantity:    integer('quantity').notNull().default(1),
  unitPrice:   numeric('unit_price',  { precision: 12, scale: 2 }).notNull(),
  costPrice:   numeric('cost_price',  { precision: 12, scale: 2 }),
  totalPrice:  numeric('total_price', { precision: 12, scale: 2 }),
  supplierSku: varchar('supplier_sku', { length: 255 }),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── V44 Supplier Orders ───────────────────────────────────────────────────────
export const v44SupplierOrders = pgTable('v44_supplier_orders', {
  id:                uuid('id').primaryKey().defaultRandom(),
  orderId:           uuid('order_id').notNull().references(() => v44Orders.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  sourceType:        varchar('source_type', { length: 50 }).notNull(),
  supplierId:        varchar('supplier_id', { length: 255 }),
  supplierProductId: varchar('supplier_product_id', { length: 255 }),
  supplierPrice:     numeric('supplier_price', { precision: 12, scale: 2 }),
  paymentStatus:     varchar('payment_status', { length: 20 }).notNull().default('unpaid'),
  autoPlaced:        boolean('auto_placed').notNull().default(false),
  externalOrderId:   varchar('external_order_id', { length: 255 }),
  trackingId:        varchar('tracking_id', { length: 255 }),
  trackingUrl:       text('tracking_url'),
  orderPayload:      jsonb('order_payload').notNull().default({}),
  apiResponse:       jsonb('api_response').default({}),
  errorMessage:      text('error_message'),
  retryCount:        integer('retry_count').notNull().default(0),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── V44 Order Logs ────────────────────────────────────────────────────────────
export const v44OrderLogs = pgTable('v44_order_logs', {
  id:        bigserial('id', { mode: 'number' }).primaryKey(),
  orderId:   uuid('order_id').notNull().references(() => v44Orders.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  event:     varchar('event', { length: 100 }).notNull(),
  status:    varchar('status', { length: 50 }),
  message:   text('message'),
  payload:   jsonb('payload').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Pipeline Tables (migrated from TypeORM — V67 Critical Fix #2) ─────────────
// TypeORM entities (Creative, CreativePerformance, LearningData, BanditSession,
// PipelineRun) have been removed. These Drizzle tables are the single source of truth.

export const creatives = pgTable('creatives', {
  id:           uuid('id').primaryKey().defaultRandom(),
  productId:    uuid('product_id').notNull(),
  hook:         text('hook').notNull(),
  type:         varchar('type', { length: 20 }).notNull().default('image'),  // 'video' | 'image'
  score:        doublePrecision('score').notNull().default(0),
  predictedCtr: doublePrecision('predicted_ctr').notNull().default(0),
  predictedCvr: doublePrecision('predicted_cvr').notNull().default(0),
  confidence:   doublePrecision('confidence').notNull().default(0),
  status:       varchar('status', { length: 20 }).notNull().default('testing'), // testing|active|killed|paused|winner
  assetUrl:     text('asset_url'),
  metadata:     jsonb('metadata').default({}),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creativePerformance = pgTable('creative_performance', {
  id:          uuid('id').primaryKey().defaultRandom(),
  creativeId:  uuid('creative_id').notNull().references(() => creatives.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  impressions: bigint('impressions', { mode: 'number' }).notNull().default(0),
  clicks:      bigint('clicks', { mode: 'number' }).notNull().default(0),
  conversions: bigint('conversions', { mode: 'number' }).notNull().default(0),
  ctr:         doublePrecision('ctr').notNull().default(0),
  cpc:         doublePrecision('cpc').notNull().default(0),
  roas:        doublePrecision('roas').notNull().default(0),
  spend:       doublePrecision('spend').notNull().default(0),
  revenue:     doublePrecision('revenue').notNull().default(0),
  frequency:   doublePrecision('frequency'),
  reach:       doublePrecision('reach'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const learningData = pgTable('learning_data', {
  id:               uuid('id').primaryKey().defaultRandom(),
  creativeType:     varchar('creative_type', { length: 50 }).notNull(),  // 'video' | 'image'
  hook:             text('hook').notNull(),
  niche:            varchar('niche', { length: 100 }).notNull(),
  platform:         varchar('platform', { length: 50 }).notNull().default('instagram'),
  ctr:              doublePrecision('ctr').notNull(),
  cvr:              doublePrecision('cvr').notNull().default(0),
  roas:             doublePrecision('roas').notNull(),
  hookStrength:     doublePrecision('hook_strength').notNull().default(5),
  sourceCreativeId: uuid('source_creative_id'),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const banditSessions = pgTable('bandit_sessions', {
  id:              uuid('id').primaryKey().defaultRandom(),
  sessionKey:      varchar('session_key', { length: 100 }).notNull(),
  productId:       uuid('product_id').notNull(),
  totalBudget:     doublePrecision('total_budget').notNull(),
  remainingBudget: doublePrecision('remaining_budget').notNull().default(0),
  round:           integer('round').notNull().default(0),
  winnerCreativeId: uuid('winner_creative_id'),
  armsSnapshot:    jsonb('arms_snapshot'),
  status:          varchar('status', { length: 20 }).notNull().default('running'), // running|completed|aborted
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pipelineRuns = pgTable('pipeline_runs', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  runKey:                varchar('run_key', { length: 100 }).notNull(),
  productId:             uuid('product_id').notNull(),
  status:                varchar('status', { length: 30 }).notNull(),
  creativesGenerated:    integer('creatives_generated').notNull().default(0),
  creativesPassedFilter: integer('creatives_passed_filter').notNull().default(0),
  winnerCreativeId:      uuid('winner_creative_id'),
  finalRoas:             doublePrecision('final_roas').notNull().default(0),
  totalSpend:            doublePrecision('total_spend').notNull().default(0),
  totalRevenue:          doublePrecision('total_revenue').notNull().default(0),
  profit:                doublePrecision('profit').notNull().default(0),
  durationMs:            integer('duration_ms').notNull().default(0),
  nextAction:            varchar('next_action', { length: 50 }).notNull(),
  error:                 text('error'),
  createdAt:             timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Attribution Events (migrated from v22/attribution/ — V68 Legacy Removal) ──
// Previously in v22/attribution/attribution-events.schema.ts
// v22 directory deleted in V68. These tables preserved in canonical schema.

export const attributionEvents = pgTable('attribution_events', {
  id:            bigserial('id', { mode: 'number' }).primaryKey(),
  sessionId:     varchar('session_id', { length: 255 }).notNull(),
  orderId:       uuid('order_id').references(() => orders.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  channel:       varchar('channel', { length: 50 }).notNull(),  // 'meta_ads' | 'organic' | 'email' | 'direct'
  utmSource:     varchar('utm_source', { length: 100 }),
  utmMedium:     varchar('utm_medium', { length: 100 }),
  utmCampaign:   varchar('utm_campaign', { length: 255 }),
  utmContent:    varchar('utm_content', { length: 255 }),
  utmTerm:       varchar('utm_term', { length: 255 }),
  adId:          varchar('ad_id', { length: 255 }),
  adSetId:       varchar('ad_set_id', { length: 255 }),
  campaignId:    varchar('campaign_id', { length: 255 }),
  revenue:       numeric('revenue', { precision: 12, scale: 2 }).default('0'),
  conversionValue: numeric('conversion_value', { precision: 12, scale: 2 }).default('0'),
  touchpointType: varchar('touchpoint_type', { length: 30 }).notNull().default('last_click'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const v22AttributionResults = pgTable('v22_attribution_results', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  orderId:             uuid('order_id').references(() => orders.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  winningChannel:      varchar('winning_channel', { length: 50 }).notNull(),
  confidence:          numeric('confidence', { precision: 5, scale: 4 }).notNull().default('0'),
  attributedRevenue:   numeric('attributed_revenue', { precision: 12, scale: 2 }).notNull().default('0'),
  attributionModel:    varchar('attribution_model', { length: 30 }).notNull().default('data_driven'),
  touchpointCount:     integer('touchpoint_count').notNull().default(1),
  firstTouch:          jsonb('first_touch').default({}),
  lastTouch:           jsonb('last_touch').default({}),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Outbox Events (canonical definition — V68 moved to schema.ts) ─────────────
// Previously defined only in src/outbox/outbox.service.ts.
// V68: Moved to schema.ts (single source of truth). outbox.service.ts re-exports.
export const outboxEvents = pgTable('outbox_events', {
  id:            uuid('id').primaryKey().defaultRandom(),
  eventType:     varchar('event_type',    { length: 100 }).notNull(),
  aggregateId:   varchar('aggregate_id',  { length: 255 }).notNull(),
  aggregateType: varchar('aggregate_type',{ length: 100 }).notNull(),
  payload:       jsonb('payload').notNull().default({}),
  status:        varchar('status', { length: 20 }).notNull().default('pending'),
  attempts:      integer('attempts').notNull().default(0),
  maxAttempts:   integer('max_attempts').notNull().default(5),
  processAfter:  timestamp('process_after', { withTimezone: true }).notNull().defaultNow(),
  processedAt:   timestamp('processed_at', { withTimezone: true }),
  error:         text('error'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
