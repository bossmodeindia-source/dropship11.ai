-- ─────────────────────────────────────────────────────────────────────────────
-- Meta Ads – Performance Tracking Migration
-- Run AFTER migration.sql (meta_adsets + meta_ad_creatives).
-- Every statement is idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Performance status enum
DO $$ BEGIN
  CREATE TYPE campaign_performance_status AS ENUM (
    'poor', 'average', 'good',
    'profitable', 'break_even', 'loss',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. New columns on campaigns
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS impressions        INTEGER,
  ADD COLUMN IF NOT EXISTS clicks             INTEGER,
  ADD COLUMN IF NOT EXISTS conversions        INTEGER,
  ADD COLUMN IF NOT EXISTS ctr                NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS cpc                NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS roas               NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS performance_status campaign_performance_status
                             NOT NULL DEFAULT 'unknown';

-- 3. Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_campaigns_performance_status
  ON campaigns (performance_status);

CREATE INDEX IF NOT EXISTS idx_campaigns_platform_status
  ON campaigns (platform, status);

CREATE INDEX IF NOT EXISTS idx_campaigns_roas
  ON campaigns (roas)
  WHERE roas IS NOT NULL;
