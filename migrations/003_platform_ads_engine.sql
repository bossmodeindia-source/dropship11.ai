-- =============================================================================
-- Migration: 003_platform_ads_engine.sql
-- Platform Ads Engine — AI Empire Bot SaaS Growth System
-- ISOLATED from all tenant / user / commerce tables.
-- =============================================================================

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE platform_campaign_type AS ENUM (
    'WEBSITE_TRAFFIC',
    'SIGNUP',
    'FREE_TRIAL',
    'SUBSCRIPTION_CONVERSION',
    'RETARGETING',
    'WHATSAPP_LEAD',
    'VIDEO_VIEW'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE platform_campaign_mode AS ENUM ('PAID', 'ORGANIC', 'HYBRID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE platform_campaign_status AS ENUM (
    'DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'KILLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE platform_creative_type AS ENUM (
    'IMAGE', 'VIDEO', 'REEL', 'CAROUSEL', 'STORY'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE platform_lead_stage AS ENUM (
    'IMPRESSION', 'CLICK', 'SIGNUP', 'TRIAL', 'SUBSCRIBED', 'CHURNED', 'REACTIVATED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE platform_channel AS ENUM (
    'META', 'INSTAGRAM', 'FACEBOOK', 'REELS', 'GOOGLE', 'TIKTOK', 'ORGANIC', 'WHATSAPP'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tables ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_campaigns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  type                 platform_campaign_type NOT NULL,
  mode                 platform_campaign_mode NOT NULL DEFAULT 'PAID',
  channel              platform_channel NOT NULL DEFAULT 'META',
  status               platform_campaign_status NOT NULL DEFAULT 'DRAFT',

  meta_campaign_id     VARCHAR(64),
  meta_ad_account_id   VARCHAR(64),
  meta_pixel_id        VARCHAR(64),

  daily_budget_inr     INTEGER NOT NULL DEFAULT 500,
  total_spend_inr      NUMERIC(14,2) DEFAULT 0,
  max_daily_spend_inr  INTEGER NOT NULL DEFAULT 5000,

  targeting            JSONB DEFAULT '{}',
  geo_locations        JSONB DEFAULT '["IN"]',
  age_min              INTEGER DEFAULT 18,
  age_max              INTEGER DEFAULT 55,

  objective            VARCHAR(64) DEFAULT 'CONVERSIONS',
  conversion_event     VARCHAR(64) DEFAULT 'COMPLETE_REGISTRATION',
  destination_url      TEXT,
  notes                TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_campaigns_status ON platform_campaigns(status);

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_ad_sets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          UUID NOT NULL REFERENCES platform_campaigns(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  meta_ad_set_id       VARCHAR(64),
  status               platform_campaign_status NOT NULL DEFAULT 'DRAFT',
  daily_budget_inr     INTEGER NOT NULL DEFAULT 500,
  targeting            JSONB DEFAULT '{}',
  optimization_goal    VARCHAR(64) DEFAULT 'LINK_CLICKS',
  billing_event        VARCHAR(64) DEFAULT 'IMPRESSIONS',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_adsets_campaign ON platform_ad_sets(campaign_id);

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_creatives (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          UUID REFERENCES platform_campaigns(id) ON DELETE SET NULL,
  name                 TEXT NOT NULL,
  type                 platform_creative_type NOT NULL DEFAULT 'IMAGE',
  status               platform_campaign_status NOT NULL DEFAULT 'DRAFT',
  meta_creative_id     VARCHAR(64),

  hook                 TEXT,
  caption              TEXT,
  headline             TEXT,
  cta                  VARCHAR(64) DEFAULT 'SIGN_UP',
  hashtags             JSONB DEFAULT '[]',
  image_prompt         TEXT,
  video_prompt         TEXT,
  reel_script          TEXT,
  ad_copy              TEXT,

  predicted_ctr        NUMERIC(6,4),
  predicted_roas       NUMERIC(6,2),
  confidence_score     NUMERIC(4,2),
  scoring_recommendation VARCHAR(32),

  wins                 INTEGER DEFAULT 0,
  trials               INTEGER DEFAULT 0,

  image_url            TEXT,
  video_url            TEXT,
  storage_key          TEXT,

  is_winner            BOOLEAN DEFAULT FALSE,
  ai_generated         BOOLEAN DEFAULT TRUE,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_creatives_campaign ON platform_creatives(campaign_id);
CREATE INDEX IF NOT EXISTS idx_platform_creatives_winner   ON platform_creatives(is_winner);

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_metrics (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id                   UUID NOT NULL REFERENCES platform_campaigns(id) ON DELETE CASCADE,
  ad_set_id                     UUID REFERENCES platform_ad_sets(id) ON DELETE SET NULL,
  creative_id                   UUID REFERENCES platform_creatives(id) ON DELETE SET NULL,
  date                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  impressions                   INTEGER DEFAULT 0,
  reach                         INTEGER DEFAULT 0,
  clicks                        INTEGER DEFAULT 0,
  spend_inr                     NUMERIC(14,2) DEFAULT 0,

  cpm                           NUMERIC(10,4),
  cpc                           NUMERIC(10,4),
  ctr                           NUMERIC(6,4),
  cac                           NUMERIC(10,2),
  roas                          NUMERIC(8,2),

  signups                       INTEGER DEFAULT 0,
  trials                        INTEGER DEFAULT 0,
  subscriptions                 INTEGER DEFAULT 0,
  signup_conversion_rate        NUMERIC(6,4),
  subscription_conversion_rate  NUMERIC(6,4),
  trial_conversion_rate         NUMERIC(6,4),

  revenue_inr                   NUMERIC(14,2) DEFAULT 0,
  ltv                           NUMERIC(14,2),
  ltv_cac_ratio                 NUMERIC(8,2),

  raw_data                      JSONB DEFAULT '{}',
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_metrics_campaign_date
  ON platform_metrics(campaign_id, date);

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_leads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID REFERENCES platform_campaigns(id) ON DELETE SET NULL,
  creative_id    UUID REFERENCES platform_creatives(id) ON DELETE SET NULL,
  stage          platform_lead_stage NOT NULL,
  email          VARCHAR(320),
  phone          VARCHAR(20),
  meta_lead_id   VARCHAR(64),
  utm_source     VARCHAR(128),
  utm_medium     VARCHAR(128),
  utm_campaign   VARCHAR(128),
  metadata       JSONB DEFAULT '{}',
  converted_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_leads_stage    ON platform_leads(stage);
CREATE INDEX IF NOT EXISTS idx_platform_leads_campaign ON platform_leads(campaign_id);

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_funnels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  campaign_id     UUID REFERENCES platform_campaigns(id) ON DELETE SET NULL,
  impressions     INTEGER DEFAULT 0,
  clicks          INTEGER DEFAULT 0,
  signups         INTEGER DEFAULT 0,
  trials          INTEGER DEFAULT 0,
  subscriptions   INTEGER DEFAULT 0,
  churns          INTEGER DEFAULT 0,
  reactivations   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_retargeting (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  segment          VARCHAR(128) NOT NULL,
  audience_size    INTEGER DEFAULT 0,
  meta_audience_id VARCHAR(64),
  is_active        BOOLEAN DEFAULT TRUE,
  last_sync_at     TIMESTAMPTZ,
  campaign_id      UUID REFERENCES platform_campaigns(id) ON DELETE SET NULL,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_growth_analytics (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  daily_signups           INTEGER DEFAULT 0,
  daily_trials            INTEGER DEFAULT 0,
  daily_subscriptions     INTEGER DEFAULT 0,
  daily_churns            INTEGER DEFAULT 0,
  active_subscriptions    INTEGER DEFAULT 0,

  daily_ad_spend_inr      NUMERIC(14,2) DEFAULT 0,
  daily_revenue_inr       NUMERIC(14,2) DEFAULT 0,
  daily_profit_inr        NUMERIC(14,2) DEFAULT 0,
  monthly_revenue_inr     NUMERIC(14,2),
  average_cac             NUMERIC(10,2),
  average_ltv             NUMERIC(14,2),
  ltv_cac_ratio           NUMERIC(8,2),

  blended_roas            NUMERIC(8,2),
  blended_cac             NUMERIC(10,2),

  snapshot                JSONB DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_growth_analytics_date
  ON platform_growth_analytics(date);
