-- ─────────────────────────────────────────────────────────────────────────────
-- AI Creative Assets Migration
-- Run AFTER all previous migrations.  Fully idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ad_creative_assets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID        NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  campaign_id   UUID                 REFERENCES campaigns(id) ON DELETE SET NULL,
  -- Arrays of generated copy
  hooks         TEXT[]      NOT NULL DEFAULT '{}',
  captions      TEXT[]      NOT NULL DEFAULT '{}',
  headlines     TEXT[]      NOT NULL DEFAULT '{}',
  -- Structured video script: { hook, problem, solution, cta }
  video_script  JSONB       NOT NULL DEFAULT '{}',
  ai_generated  BOOLEAN     NOT NULL DEFAULT FALSE,
  model         VARCHAR(100) NOT NULL DEFAULT 'template',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ad_creative_assets_product_id
  ON ad_creative_assets (product_id);

CREATE INDEX IF NOT EXISTS idx_ad_creative_assets_user_id
  ON ad_creative_assets (user_id);

CREATE INDEX IF NOT EXISTS idx_ad_creative_assets_campaign_id
  ON ad_creative_assets (campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ad_creative_assets_ai_generated
  ON ad_creative_assets (ai_generated);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_ad_creative_assets_updated_at
    BEFORE UPDATE ON ad_creative_assets
    FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
