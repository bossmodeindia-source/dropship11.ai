-- ────────────────────────────────────────────────────────────────────────────
-- Migration: ad_media_assets  (HARDENED)
-- Fix: Added UNIQUE constraint on prompt_hash to prevent duplicate rows
--      under concurrent requests.  Uses ON CONFLICT DO NOTHING in app layer.
-- Run once: psql $DATABASE_URL < src/ai-media/ad-media-assets.migration.sql
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ad_media_assets (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  campaign_id         UUID         REFERENCES campaigns(id) ON DELETE SET NULL,
  image_url           TEXT,
  video_url           TEXT,
  prompt_hash         VARCHAR(64)  NOT NULL,
  provider            VARCHAR(100) NOT NULL DEFAULT 'open-generative-ai',
  generation_time_ms  INTEGER,
  success             BOOLEAN      NOT NULL DEFAULT TRUE,
  use_count           INTEGER      NOT NULL DEFAULT 1,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- FIX 3: UNIQUE constraint on prompt_hash prevents duplicate cache rows
-- under high concurrency. The app uses INSERT ... ON CONFLICT DO NOTHING.
ALTER TABLE ad_media_assets
  ADD CONSTRAINT uq_ad_media_assets_prompt_hash UNIQUE (prompt_hash);

-- Fast cache lookup by hash (covering index, also enforces uniqueness)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_media_assets_prompt_hash
  ON ad_media_assets (prompt_hash);

-- Fast getBestCreative() per product
CREATE INDEX IF NOT EXISTS idx_ad_media_assets_product_use
  ON ad_media_assets (product_id, use_count DESC, created_at DESC);
