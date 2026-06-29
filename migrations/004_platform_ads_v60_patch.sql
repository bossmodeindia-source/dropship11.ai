-- V60 Platform Ads Patch Migration
-- Run order: after existing platform-ads schema migration

-- ── 1. Track Meta Custom Audience IDs on retargeting rows ────────────────────
--
-- Previously platform_retargeting had no column to store the Meta audience ID.
-- Now that buildAllAudiences() creates real Meta Custom Audiences and uploads
-- hashed emails, we need to track the ID for future audience updates.

ALTER TABLE platform_retargeting
  ADD COLUMN IF NOT EXISTS meta_audience_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS last_audience_upload_at TIMESTAMPTZ;

COMMENT ON COLUMN platform_retargeting.meta_audience_id IS
  'Meta Custom Audience ID. Populated when buildAllAudiences() uploads hashed emails.';

COMMENT ON COLUMN platform_retargeting.last_audience_upload_at IS
  'Timestamp of the last successful email upload to Meta Custom Audiences.';

-- ── 2. Index for emergency kill query (C1 fix) ────────────────────────────────
--
-- forceKillAllCampaigns() now queries:
--   SELECT id, meta_campaign_id FROM platform_campaigns WHERE status = 'ACTIVE'
-- This index ensures the WHERE clause is index-scanned under load.

CREATE INDEX IF NOT EXISTS idx_platform_campaigns_status_active
  ON platform_campaigns (status)
  WHERE status = 'ACTIVE';

-- ── 3. platform_metrics: store assumed_ltv alongside ltv_cac_ratio ────────────
--
-- The H3 fix makes assumed_ltv configurable via env var.
-- Record the value used at metric ingestion time so historical data
-- is self-documenting (avoids confusion when the env var changes later).

ALTER TABLE platform_metrics
  ADD COLUMN IF NOT EXISTS assumed_ltv_inr INTEGER;

COMMENT ON COLUMN platform_metrics.assumed_ltv_inr IS
  'Value of PLATFORM_ASSUMED_LTV_INR env var at the time this metric row was ingested.';

-- Backfill existing rows using the ltv column (was hardcoded 3000)
UPDATE platform_metrics
SET assumed_ltv_inr = 3000
WHERE assumed_ltv_inr IS NULL;

-- ── 4. platform_growth_analytics: same assumed_ltv tracking ──────────────────

ALTER TABLE platform_growth_analytics
  ADD COLUMN IF NOT EXISTS assumed_ltv_inr INTEGER;

UPDATE platform_growth_analytics
SET assumed_ltv_inr = 3000
WHERE assumed_ltv_inr IS NULL;

-- ── 5. Audit index for pauseAll reason ───────────────────────────────────────
--
-- With the PauseAllDto fix, reason is now always a non-empty string.
-- Add an audit_log trigger placeholder (implement with your audit module).
-- For now just ensure updated_at is always stamped on pause.

-- No schema change needed — existing updated_at column covers this.
-- The controller now returns reason in the response body for HTTP-layer audit.

-- ── Verify ───────────────────────────────────────────────────────────────────

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) = 1
    FROM information_schema.columns
    WHERE table_name = 'platform_retargeting'
      AND column_name = 'meta_audience_id'
  ), 'V60 migration: meta_audience_id column missing on platform_retargeting';

  ASSERT (
    SELECT COUNT(*) = 1
    FROM information_schema.columns
    WHERE table_name = 'platform_metrics'
      AND column_name = 'assumed_ltv_inr'
  ), 'V60 migration: assumed_ltv_inr column missing on platform_metrics';

  RAISE NOTICE 'V60 platform-ads migration: all assertions passed ✓';
END $$;
