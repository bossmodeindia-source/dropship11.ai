-- ============================================================================
-- COMMERCE EXECUTION LAYER MIGRATION
-- Final Execution Commerce Layer — V58 Schema Extensions
--
-- Tables added:
--   commission_config    — Admin-controlled hidden commission rules
--   product_approvals    — User approval workflow with campaign mode
--   organic_posts        — Zero-rupee social media posts (IG / FB / Reels)
--   engagement_metrics   — Per-post engagement (views, likes, ER, etc.)
--   supplier_payments    — Payment records per order (blocks fulfillment)
--   campaign_modes       — Mode config per campaign (paid | organic | hybrid)
--
-- Run:  psql $DATABASE_URL -f commerce-execution-migration.sql
-- ============================================================================

BEGIN;

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE campaign_mode AS ENUM ('paid', 'organic', 'hybrid');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE commission_type AS ENUM ('fixed', 'percentage');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE organic_post_status AS ENUM (
    'pending', 'scheduled', 'published', 'failed', 'boosted'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE organic_platform AS ENUM (
    'instagram', 'facebook', 'instagram_reels', 'facebook_reels'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE supplier_payment_status AS ENUM (
    'pending', 'initiated', 'paid', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── commission_config ─────────────────────────────────────────────────────────
-- ADMIN ONLY — never expose commission_amount or supplier_price to users.
-- Users see only minimumAllowedPrice = supplier_price + commission.

CREATE TABLE IF NOT EXISTS commission_config (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  is_enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
  commission_type       commission_type NOT NULL DEFAULT 'fixed',
  fixed_amount          NUMERIC(12, 2)  DEFAULT 0,
  percentage            NUMERIC(5, 2)   DEFAULT 0,
  applied_to_category   VARCHAR(100),                         -- NULL = applies to all
  min_order_value       NUMERIC(12, 2)  DEFAULT 0,
  notes                 TEXT,
  created_by            UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE commission_config IS
  'Admin-only: hidden commission rules. NEVER expose to users.';
COMMENT ON COLUMN commission_config.fixed_amount IS
  'Fixed rupee amount added to supplier price. Internal only.';
COMMENT ON COLUMN commission_config.percentage IS
  'Percentage of supplier price added as commission. Internal only.';

-- ── product_approvals ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_approvals (
  id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID           NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id          UUID           NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  status           approval_status NOT NULL DEFAULT 'pending',
  selling_price    NUMERIC(12, 2),
  campaign_mode    campaign_mode  NOT NULL DEFAULT 'organic',
  rejected_reason  TEXT,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_product_approvals_user_status
  ON product_approvals(user_id, status);

CREATE INDEX IF NOT EXISTS idx_product_approvals_product
  ON product_approvals(product_id);

-- ── organic_posts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organic_posts (
  id                UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID               NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  product_id        UUID               NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  campaign_id       UUID               REFERENCES campaigns(id)          ON DELETE SET NULL,
  platform          organic_platform   NOT NULL,
  status            organic_post_status NOT NULL DEFAULT 'pending',
  caption           TEXT               NOT NULL,
  hashtags          TEXT[]             NOT NULL DEFAULT '{}',
  hook              TEXT,
  media_urls        TEXT[]             NOT NULL DEFAULT '{}',
  video_script      JSONB              DEFAULT '{}',
  external_post_id  VARCHAR(255),
  external_post_url TEXT,
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  failure_reason    TEXT,
  boost_campaign_id VARCHAR(255),
  is_boosted        BOOLEAN            NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organic_posts_user     ON organic_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_organic_posts_product  ON organic_posts(product_id);
CREATE INDEX IF NOT EXISTS idx_organic_posts_status   ON organic_posts(status);
CREATE INDEX IF NOT EXISTS idx_organic_posts_scheduled
  ON organic_posts(scheduled_at) WHERE status = 'scheduled';

-- ── engagement_metrics ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS engagement_metrics (
  id               UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  organic_post_id  UUID             NOT NULL REFERENCES organic_posts(id) ON DELETE CASCADE,
  platform         organic_platform NOT NULL,
  views            INTEGER          NOT NULL DEFAULT 0,
  likes            INTEGER          NOT NULL DEFAULT 0,
  comments         INTEGER          NOT NULL DEFAULT 0,
  shares           INTEGER          NOT NULL DEFAULT 0,
  saves            INTEGER          NOT NULL DEFAULT 0,
  reach            INTEGER          NOT NULL DEFAULT 0,
  engagement_rate  NUMERIC(7, 4),
  click_throughs   INTEGER          NOT NULL DEFAULT 0,
  fetched_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engagement_metrics_post
  ON engagement_metrics(organic_post_id);
CREATE INDEX IF NOT EXISTS idx_engagement_metrics_fetched
  ON engagement_metrics(fetched_at DESC);

-- ── supplier_payments ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_payments (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID                    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id         UUID                    NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  supplier_id     VARCHAR(255),
  supplier_name   VARCHAR(255),
  amount_due      NUMERIC(12, 2)          NOT NULL,
  amount_paid     NUMERIC(12, 2)          DEFAULT 0,
  currency        VARCHAR(3)              NOT NULL DEFAULT 'INR',
  status          supplier_payment_status NOT NULL DEFAULT 'pending',
  payment_ref     VARCHAR(255),
  payment_method  VARCHAR(100),
  paid_at         TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ             NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_order  ON supplier_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_user   ON supplier_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_status ON supplier_payments(status);

-- ── campaign_modes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaign_modes (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID          NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id           UUID          NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  mode              campaign_mode NOT NULL DEFAULT 'organic',
  phase             VARCHAR(50)   NOT NULL DEFAULT 'organic',   -- organic | paid | scaling
  organic_threshold NUMERIC(7, 4) DEFAULT 0.03,                 -- ER threshold for hybrid escalation
  escalated_at      TIMESTAMPTZ,
  paid_budget_inr   NUMERIC(12, 2) DEFAULT 0,
  daily_cap_inr     NUMERIC(12, 2) DEFAULT 1000,
  stop_loss_inr     NUMERIC(12, 2) DEFAULT 5000,
  is_active         BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_modes_user   ON campaign_modes(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_modes_active ON campaign_modes(is_active);

-- ── Row-level security comments ───────────────────────────────────────────────
-- commission_config: SELECT, INSERT, UPDATE restricted to admin/superadmin roles.
-- All other tables: SELECT/INSERT/UPDATE/DELETE restricted to matching user_id.

COMMENT ON TABLE supplier_payments IS
  'Supplier must be marked paid before fulfillment is unblocked.';

COMMENT ON TABLE campaign_modes IS
  'Per-campaign mode config. phase tracks current execution step for hybrid campaigns.';

COMMIT;
