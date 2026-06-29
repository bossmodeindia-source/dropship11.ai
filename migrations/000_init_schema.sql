-- ============================================================================
-- Migration 000 — Initial Schema (Core Tables)
-- AI Empire V63 — Base schema: users, auth, subscriptions, products, orders,
--                              campaigns, meta_ads, audit_logs, ai_usage
--
-- Run first before all other migrations.
-- Idempotent: all CREATE TABLE uses IF NOT EXISTS.
-- ============================================================================

BEGIN;

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram search on email/name
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- GIN index support

-- ── Enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('user', 'admin', 'superadmin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_tier AS ENUM ('free', 'starter', 'pro', 'enterprise'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_status AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'paused'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE product_decision AS ENUM ('RUN_ADS', 'TEST_ADS', 'REJECT', 'PENDING'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE product_status AS ENUM ('pending', 'scored', 'listed', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_status AS ENUM ('received', 'queued', 'processing', 'supplier_submitted', 'supplier_confirmed', 'shipped', 'delivered', 'failed', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE ai_mode AS ENUM ('AI', 'BOT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE meta_ad_status AS ENUM ('draft', 'pending', 'active', 'paused', 'error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE campaign_performance_status AS ENUM ('poor', 'average', 'good', 'profitable', 'break_even', 'loss', 'unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE audit_severity AS ENUM ('info', 'warn', 'critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  role            user_role    NOT NULL DEFAULT 'user',
  full_name       VARCHAR(255),
  company_name    VARCHAR(255),
  ai_mode         ai_mode      NOT NULL DEFAULT 'BOT',
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  is_verified     BOOLEAN      NOT NULL DEFAULT false,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email   ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_active  ON users (is_active);

-- ── Refresh Tokens ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires    ON refresh_tokens (expires_at);

-- ── Subscriptions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   UUID                NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID                NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  tier                 subscription_tier   NOT NULL DEFAULT 'free',
  status               subscription_status NOT NULL DEFAULT 'active',
  external_customer_id VARCHAR(255),
  external_sub_id      VARCHAR(255),
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN             NOT NULL DEFAULT false,
  product_limit        INTEGER             NOT NULL DEFAULT 10,
  order_limit          INTEGER             NOT NULL DEFAULT 50,
  ai_requests_limit    INTEGER             NOT NULL DEFAULT 0,
  ai_requests_used     INTEGER             NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier    ON subscriptions (tier);

-- ── Shopify API Keys ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopify_api_keys (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_domain    VARCHAR(255) NOT NULL,
  access_token   TEXT        NOT NULL,
  webhook_secret TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Products ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id               UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id        UUID,
  name             VARCHAR(500)     NOT NULL,
  description      TEXT,
  supplier_url     TEXT,
  supplier_price   NUMERIC(12, 2),
  selling_price    NUMERIC(12, 2),
  category         VARCHAR(255),
  tags             JSONB            NOT NULL DEFAULT '[]',
  images           JSONB            NOT NULL DEFAULT '[]',
  ai_score         NUMERIC(5, 2),
  decision         product_decision NOT NULL DEFAULT 'PENDING',
  status           product_status   NOT NULL DEFAULT 'pending',
  shopify_id       VARCHAR(255),
  meta_data        JSONB            NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_user_id  ON products (user_id);
CREATE INDEX IF NOT EXISTS idx_products_status   ON products (status);
CREATE INDEX IF NOT EXISTS idx_products_decision ON products (decision);

-- ── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id           UUID,
  shopify_order_id    VARCHAR(255) UNIQUE,
  shopify_order_number VARCHAR(100),
  product_id          UUID         REFERENCES products(id) ON DELETE SET NULL,
  customer_name       VARCHAR(255),
  customer_email      VARCHAR(255),
  shipping_address    JSONB,
  line_items          JSONB        NOT NULL DEFAULT '[]',
  subtotal            NUMERIC(12, 2),
  total               NUMERIC(12, 2),
  currency            VARCHAR(10)  NOT NULL DEFAULT 'INR',
  status              order_status NOT NULL DEFAULT 'received',
  supplier_order_id   VARCHAR(255),
  tracking_number     VARCHAR(255),
  tracking_url        TEXT,
  fulfillment_data    JSONB        NOT NULL DEFAULT '{}',
  error_message       TEXT,
  retry_count         INTEGER      NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id        ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_shopify_id     ON orders (shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at     ON orders (created_at DESC);

-- ── Supplier Payments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_payments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID        REFERENCES orders(id) ON DELETE SET NULL,
  amount           NUMERIC(12, 2) NOT NULL,
  currency         VARCHAR(10) NOT NULL DEFAULT 'INR',
  status           VARCHAR(50) NOT NULL DEFAULT 'pending',
  payment_method   VARCHAR(100),
  reference_id     VARCHAR(255),
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Campaigns ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID,
  product_id      UUID        REFERENCES products(id) ON DELETE SET NULL,
  name            VARCHAR(500) NOT NULL,
  type            VARCHAR(100) NOT NULL DEFAULT 'meta_ads',
  status          VARCHAR(100) NOT NULL DEFAULT 'draft',
  budget_daily    NUMERIC(12, 2),
  budget_total    NUMERIC(12, 2),
  target_audience JSONB       NOT NULL DEFAULT '{}',
  ad_content      JSONB       NOT NULL DEFAULT '{}',
  metrics         JSONB       NOT NULL DEFAULT '{}',
  performance     campaign_performance_status NOT NULL DEFAULT 'unknown',
  meta_campaign_id VARCHAR(255),
  meta_adset_id   VARCHAR(255),
  meta_ad_id      VARCHAR(255),
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns (user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status  ON campaigns (status);

-- ── Meta Ads ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_ads (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID,
  campaign_id     UUID          REFERENCES campaigns(id) ON DELETE SET NULL,
  product_id      UUID          REFERENCES products(id) ON DELETE SET NULL,
  status          meta_ad_status NOT NULL DEFAULT 'draft',
  headline        TEXT,
  body            TEXT,
  image_url       TEXT,
  video_url       TEXT,
  cta             VARCHAR(100),
  targeting       JSONB         NOT NULL DEFAULT '{}',
  budget_inr      NUMERIC(12, 2),
  spend_inr       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  impressions     INTEGER       NOT NULL DEFAULT 0,
  clicks          INTEGER       NOT NULL DEFAULT 0,
  conversions     INTEGER       NOT NULL DEFAULT 0,
  revenue_inr     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  roas            NUMERIC(8, 4),
  meta_id         VARCHAR(255),
  error_message   TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_user_id   ON meta_ads (user_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_status    ON meta_ads (status);
CREATE INDEX IF NOT EXISTS idx_meta_ads_campaign  ON meta_ads (campaign_id);

-- ── Audit Logs ────────────────────────────────────────────────────────────────
-- Used by AuditService (raw SQL INSERT) — column names match service exactly.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  tenant_id   TEXT,                        -- 'system' for global events
  actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,        -- free-form: 'auth.login', 'VAULT_DECRYPT', etc.
  resource    TEXT,
  resource_id TEXT,
  details     JSONB,
  severity    TEXT        NOT NULL DEFAULT 'info'
              CHECK (severity IN ('info', 'warn', 'critical')),
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor_id   ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_id  ON audit_logs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs (created_at DESC);

-- ── AI Usage Logs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  tenant_id    UUID,
  provider     VARCHAR(100) NOT NULL,
  model        VARCHAR(200) NOT NULL,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(10, 6) NOT NULL DEFAULT 0,
  latency_ms   INTEGER,
  success      BOOLEAN     NOT NULL DEFAULT true,
  error_code   VARCHAR(100),
  request_type VARCHAR(100),
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_id    ON ai_usage_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider   ON ai_usage_logs (provider);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage_logs (created_at DESC);

-- ── Vault (per-tenant encrypted credentials) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS vault_credentials (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_name    VARCHAR(255) NOT NULL,
  ciphertext  TEXT        NOT NULL,
  iv          VARCHAR(64) NOT NULL,
  tag         VARCHAR(64) NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, key_name)
);

CREATE INDEX IF NOT EXISTS idx_vault_tenant_id ON vault_credentials (tenant_id);
CREATE INDEX IF NOT EXISTS idx_vault_user_id   ON vault_credentials (user_id);

-- ── Schema Migrations Tracker ─────────────────────────────────────────────────
-- Created here too so it exists when migration runner first runs.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(255) PRIMARY KEY,
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  checksum    VARCHAR(64)
);

COMMIT;
