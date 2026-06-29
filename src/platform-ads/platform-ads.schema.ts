/**
 * platform-ads.schema.ts — Platform Ads Engine Schema
 *
 * ISOLATED from all tenant / user / Shopify / supplier tables.
 * These tables track AI Empire Bot's own SaaS growth campaigns.
 *
 * Tables:
 *   platform_campaigns         — campaign master records
 *   platform_ad_sets           — ad set / audience configs
 *   platform_creatives         — generated ad creatives
 *   platform_metrics           — daily performance snapshots
 *   platform_leads             — signup / trial / conversion events
 *   platform_funnels           — funnel stage tracking
 *   platform_retargeting       — retargeting audience segments
 *   platform_growth_analytics  — aggregated SaaS growth KPIs
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const platformCampaignTypeEnum = pgEnum('platform_campaign_type', [
  'WEBSITE_TRAFFIC',
  'SIGNUP',
  'FREE_TRIAL',
  'SUBSCRIPTION_CONVERSION',
  'RETARGETING',
  'WHATSAPP_LEAD',
  'VIDEO_VIEW',
]);

export const platformCampaignModeEnum = pgEnum('platform_campaign_mode', [
  'PAID',
  'ORGANIC',
  'HYBRID',
]);

export const platformCampaignStatusEnum = pgEnum('platform_campaign_status', [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'KILLED',
]);

export const platformCreativeTypeEnum = pgEnum('platform_creative_type', [
  'IMAGE',
  'VIDEO',
  'REEL',
  'CAROUSEL',
  'STORY',
]);

export const platformLeadStageEnum = pgEnum('platform_lead_stage', [
  'IMPRESSION',
  'CLICK',
  'SIGNUP',
  'TRIAL',
  'SUBSCRIBED',
  'CHURNED',
  'REACTIVATED',
]);

export const platformChannelEnum = pgEnum('platform_channel', [
  'META',
  'INSTAGRAM',
  'FACEBOOK',
  'REELS',
  'GOOGLE',
  'TIKTOK',
  'ORGANIC',
  'WHATSAPP',
]);

// ── Tables ────────────────────────────────────────────────────────────────────

export const platformCampaigns = pgTable('platform_campaigns', {
  id:              uuid('id').primaryKey().defaultRandom(),
  name:            text('name').notNull(),
  type:            platformCampaignTypeEnum('type').notNull(),
  mode:            platformCampaignModeEnum('mode').notNull().default('PAID'),
  channel:         platformChannelEnum('channel').notNull().default('META'),
  status:          platformCampaignStatusEnum('status').notNull().default('DRAFT'),

  // Meta / platform IDs (stored as encrypted strings in the service layer)
  metaCampaignId:  varchar('meta_campaign_id', { length: 64 }),
  metaAdAccountId: varchar('meta_ad_account_id', { length: 64 }),
  metaPixelId:     varchar('meta_pixel_id', { length: 64 }),

  // Budget
  dailyBudgetInr:  integer('daily_budget_inr').notNull().default(500),
  totalSpendInr:   numeric('total_spend_inr', { precision: 14, scale: 2 }).default('0'),
  maxDailySpendInr:integer('max_daily_spend_inr').notNull().default(5000),

  // Targeting
  targeting:       jsonb('targeting').$type<Record<string, unknown>>().default({}),
  geoLocations:    jsonb('geo_locations').$type<string[]>().default(['IN']),
  ageMin:          integer('age_min').default(18),
  ageMax:          integer('age_max').default(55),

  // Objective / conversion tracking
  objective:       varchar('objective', { length: 64 }).default('CONVERSIONS'),
  conversionEvent: varchar('conversion_event', { length: 64 }).default('COMPLETE_REGISTRATION'),
  destinationUrl:  text('destination_url'),

  // Notes
  notes:           text('notes'),

  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  statusIdx: index('idx_platform_campaigns_status').on(t.status),
}));

export const platformAdSets = pgTable('platform_ad_sets', {
  id:            uuid('id').primaryKey().defaultRandom(),
  campaignId:    uuid('campaign_id').notNull().references(() => platformCampaigns.id, { onDelete: 'cascade' }),
  name:          text('name').notNull(),
  metaAdSetId:   varchar('meta_ad_set_id', { length: 64 }),
  status:        platformCampaignStatusEnum('status').notNull().default('DRAFT'),
  dailyBudget:   integer('daily_budget_inr').notNull().default(500),
  targeting:     jsonb('targeting').$type<Record<string, unknown>>().default({}),
  optimizationGoal: varchar('optimization_goal', { length: 64 }).default('LINK_CLICKS'),
  billingEvent:  varchar('billing_event', { length: 64 }).default('IMPRESSIONS'),
  createdAt:     timestamp('created_at').notNull().defaultNow(),
  updatedAt:     timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  campaignIdx: index('idx_platform_adsets_campaign').on(t.campaignId),
}));

export const platformCreatives = pgTable('platform_creatives', {
  id:            uuid('id').primaryKey().defaultRandom(),
  campaignId:    uuid('campaign_id').references(() => platformCampaigns.id, { onDelete: 'set null' }),
  name:          text('name').notNull(),
  type:          platformCreativeTypeEnum('type').notNull().default('IMAGE'),
  status:        platformCampaignStatusEnum('status').notNull().default('DRAFT'),
  metaCreativeId:varchar('meta_creative_id', { length: 64 }),

  // Generated copy
  hook:          text('hook'),
  caption:       text('caption'),
  headline:      text('headline'),
  cta:           varchar('cta', { length: 64 }).default('SIGN_UP'),
  hashtags:      jsonb('hashtags').$type<string[]>().default([]),
  imagePrompt:   text('image_prompt'),
  videoPrompt:   text('video_prompt'),
  reelScript:    text('reel_script'),
  adCopy:        text('ad_copy'),

  // Scoring (from CreativeScoringService)
  predictedCtr:  numeric('predicted_ctr', { precision: 6, scale: 4 }),
  predictedRoas: numeric('predicted_roas', { precision: 6, scale: 2 }),
  confidenceScore: numeric('confidence_score', { precision: 4, scale: 2 }),
  scoringRecommendation: varchar('scoring_recommendation', { length: 32 }),

  // Thompson Sampling
  wins:          integer('wins').default(0),
  trials:        integer('trials').default(0),

  // Media
  imageUrl:      text('image_url'),
  videoUrl:      text('video_url'),
  storageKey:    text('storage_key'),

  isWinner:      boolean('is_winner').default(false),
  aiGenerated:   boolean('ai_generated').default(true),

  createdAt:     timestamp('created_at').notNull().defaultNow(),
  updatedAt:     timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  campaignIdx: index('idx_platform_creatives_campaign').on(t.campaignId),
  winnerIdx:   index('idx_platform_creatives_winner').on(t.isWinner),
}));

export const platformMetrics = pgTable('platform_metrics', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  campaignId:          uuid('campaign_id').notNull().references(() => platformCampaigns.id, { onDelete: 'cascade' }),
  adSetId:             uuid('ad_set_id').references(() => platformAdSets.id, { onDelete: 'set null' }),
  creativeId:          uuid('creative_id').references(() => platformCreatives.id, { onDelete: 'set null' }),
  date:                timestamp('date').notNull().defaultNow(),

  // Raw Meta metrics
  impressions:         integer('impressions').default(0),
  reach:               integer('reach').default(0),
  clicks:              integer('clicks').default(0),
  spendInr:            numeric('spend_inr', { precision: 14, scale: 2 }).default('0'),

  // Computed
  cpm:                 numeric('cpm', { precision: 10, scale: 4 }),
  cpc:                 numeric('cpc', { precision: 10, scale: 4 }),
  ctr:                 numeric('ctr', { precision: 6, scale: 4 }),
  cac:                 numeric('cac', { precision: 10, scale: 2 }),
  roas:                numeric('roas', { precision: 8, scale: 2 }),

  // SaaS funnel
  signups:             integer('signups').default(0),
  trials:              integer('trials').default(0),
  subscriptions:       integer('subscriptions').default(0),
  signupConversionRate: numeric('signup_conversion_rate', { precision: 6, scale: 4 }),
  subscriptionConversionRate: numeric('subscription_conversion_rate', { precision: 6, scale: 4 }),
  trialConversionRate: numeric('trial_conversion_rate', { precision: 6, scale: 4 }),

  // Platform revenue for this period
  revenueInr:          numeric('revenue_inr', { precision: 14, scale: 2 }).default('0'),
  ltv:                 numeric('ltv', { precision: 14, scale: 2 }),
  ltvCacRatio:         numeric('ltv_cac_ratio', { precision: 8, scale: 2 }),

  rawData:             jsonb('raw_data').$type<Record<string, unknown>>().default({}),
  createdAt:           timestamp('created_at').notNull().defaultNow(),
  updatedAt:           timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  campaignDateIdx: index('idx_platform_metrics_campaign_date').on(t.campaignId, t.date),
}));

export const platformLeads = pgTable('platform_leads', {
  id:              uuid('id').primaryKey().defaultRandom(),
  campaignId:      uuid('campaign_id').references(() => platformCampaigns.id, { onDelete: 'set null' }),
  creativeId:      uuid('creative_id').references(() => platformCreatives.id, { onDelete: 'set null' }),
  stage:           platformLeadStageEnum('stage').notNull(),
  email:           varchar('email', { length: 320 }),
  phone:           varchar('phone', { length: 20 }),
  metaLeadId:      varchar('meta_lead_id', { length: 64 }),
  utmSource:       varchar('utm_source', { length: 128 }),
  utmMedium:       varchar('utm_medium', { length: 128 }),
  utmCampaign:     varchar('utm_campaign', { length: 128 }),
  metadata:        jsonb('metadata').$type<Record<string, unknown>>().default({}),
  convertedAt:     timestamp('converted_at'),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  stageIdx:    index('idx_platform_leads_stage').on(t.stage),
  campaignIdx: index('idx_platform_leads_campaign').on(t.campaignId),
}));

export const platformFunnels = pgTable('platform_funnels', {
  id:              uuid('id').primaryKey().defaultRandom(),
  name:            text('name').notNull(),
  campaignId:      uuid('campaign_id').references(() => platformCampaigns.id, { onDelete: 'set null' }),
  impressions:     integer('impressions').default(0),
  clicks:          integer('clicks').default(0),
  signups:         integer('signups').default(0),
  trials:          integer('trials').default(0),
  subscriptions:   integer('subscriptions').default(0),
  churns:          integer('churns').default(0),
  reactivations:   integer('reactivations').default(0),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
});

export const platformRetargeting = pgTable('platform_retargeting', {
  id:              uuid('id').primaryKey().defaultRandom(),
  name:            text('name').notNull(),
  segment:         varchar('segment', { length: 128 }).notNull(),
  // Segment types: abandoned_signup | inactive_trial | failed_upgrade | canceled
  audienceSize:    integer('audience_size').default(0),
  metaAudienceId:  varchar('meta_audience_id', { length: 64 }),
  isActive:        boolean('is_active').default(true),
  lastSyncAt:      timestamp('last_sync_at'),
  campaignId:      uuid('campaign_id').references(() => platformCampaigns.id, { onDelete: 'set null' }),
  metadata:        jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
});

export const platformGrowthAnalytics = pgTable('platform_growth_analytics', {
  id:              uuid('id').primaryKey().defaultRandom(),
  date:            timestamp('date').notNull().defaultNow(),

  // SaaS KPIs
  dailySignups:    integer('daily_signups').default(0),
  dailyTrials:     integer('daily_trials').default(0),
  dailySubscriptions: integer('daily_subscriptions').default(0),
  dailyChurns:     integer('daily_churns').default(0),
  activeSubscriptions: integer('active_subscriptions').default(0),

  // Finance
  dailyAdSpendInr: numeric('daily_ad_spend_inr', { precision: 14, scale: 2 }).default('0'),
  dailyRevenueInr: numeric('daily_revenue_inr', { precision: 14, scale: 2 }).default('0'),
  dailyProfitInr:  numeric('daily_profit_inr', { precision: 14, scale: 2 }).default('0'),
  monthlyRevenueInr: numeric('monthly_revenue_inr', { precision: 14, scale: 2 }),
  averageCac:      numeric('average_cac', { precision: 10, scale: 2 }),
  averageLtv:      numeric('average_ltv', { precision: 14, scale: 2 }),
  ltvCacRatio:     numeric('ltv_cac_ratio', { precision: 8, scale: 2 }),

  // Blended metrics
  blendedRoas:     numeric('blended_roas', { precision: 8, scale: 2 }),
  blendedCac:      numeric('blended_cac', { precision: 10, scale: 2 }),

  snapshot:        jsonb('snapshot').$type<Record<string, unknown>>().default({}),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  dateIdx: index('idx_platform_growth_analytics_date').on(t.date),
}));
