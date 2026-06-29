-- ─────────────────────────────────────────────────────────────────────────────
-- Meta Ads Automation – Database Migration
-- Run AFTER the base schema.sql has been applied.
-- All statements are idempotent (IF NOT EXISTS / DO $$ … EXCEPTION WHEN …).
-- ─────────────────────────────────────────────────────────────────────────────

-- Enum: meta_ad_status
DO $$ BEGIN
  CREATE TYPE meta_ad_status AS ENUM ('draft', 'pending', 'active', 'paused', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── meta_adsets ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_adsets (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID           NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id           UUID           NOT NULL REFERENCES users(id),
  product_id        UUID           NOT NULL REFERENCES products(id),
  name              TEXT           NOT NULL,
  targeting         JSONB          NOT NULL DEFAULT '{}',
  budget_daily      NUMERIC(10,2)  NOT NULL,
  billing_event     VARCHAR(50)    NOT NULL DEFAULT 'IMPRESSIONS',
  optimization_goal VARCHAR(100)   NOT NULL,
  status            meta_ad_status NOT NULL DEFAULT 'draft',
  external_id       VARCHAR(255),
  error_message     TEXT,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_adsets_campaign_id ON meta_adsets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_adsets_user_id     ON meta_adsets(user_id);
CREATE INDEX IF NOT EXISTS idx_meta_adsets_product_id  ON meta_adsets(product_id);
CREATE INDEX IF NOT EXISTS idx_meta_adsets_status      ON meta_adsets(status);

-- ── meta_ad_creatives ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_ad_creatives (
  id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  adset_id      UUID           NOT NULL REFERENCES meta_adsets(id)  ON DELETE CASCADE,
  campaign_id   UUID           NOT NULL REFERENCES campaigns(id)    ON DELETE CASCADE,
  user_id       UUID           NOT NULL REFERENCES users(id),
  product_id    UUID           NOT NULL REFERENCES products(id),
  name          TEXT           NOT NULL,
  headline      TEXT           NOT NULL,
  body          TEXT           NOT NULL,
  cta           VARCHAR(100)   NOT NULL DEFAULT 'SHOP_NOW',
  image_url     TEXT,
  link_url      TEXT,
  status        meta_ad_status NOT NULL DEFAULT 'draft',
  external_id   VARCHAR(255),
  error_message TEXT,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_ad_creatives_adset_id    ON meta_ad_creatives(adset_id);
CREATE INDEX IF NOT EXISTS idx_meta_ad_creatives_campaign_id ON meta_ad_creatives(campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_ad_creatives_user_id     ON meta_ad_creatives(user_id);
CREATE INDEX IF NOT EXISTS idx_meta_ad_creatives_product_id  ON meta_ad_creatives(product_id);
CREATE INDEX IF NOT EXISTS idx_meta_ad_creatives_status      ON meta_ad_creatives(status);

-- ── updated_at triggers ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_meta_adsets_updated_at
    BEFORE UPDATE ON meta_adsets
    FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_meta_ad_creatives_updated_at
    BEFORE UPDATE ON meta_ad_creatives
    FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
