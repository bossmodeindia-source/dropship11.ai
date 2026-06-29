-- ============================================================
-- Migration 007 — V61.1 Campaign Dispatch + Provider Catalog
-- ============================================================
-- Adds:
--   1.  campaign_launch_events   — audit trail for paid campaign launches
--   2.  organic_publish_jobs     — adds 'dispatching' status + stall recovery index
--   3.  ai_provider_catalog      — adds approved_by / approved_at columns
--                                  (needed by ProviderRequestService.review())
--   4.  ai_provider_requests     — ensure provider_url / docs_url columns exist
--                                  (migration 006 may have omitted them)
-- ============================================================

BEGIN;

-- ── 1. campaign_launch_events ─────────────────────────────────────────────────
-- Written by CampaignLaunchProcessor after each paid campaign launch.
-- Provides an immutable audit trail per tenant/cycle/platform.

CREATE TABLE IF NOT EXISTS campaign_launch_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  cycle_id        TEXT,                              -- UnifiedOrchestrator cycleId
  campaign_id     UUID,                              -- internal campaign row if exists
  platform        TEXT        NOT NULL DEFAULT 'meta',
  status          TEXT        NOT NULL DEFAULT 'launched'
                              CHECK (status IN ('launched','failed','paused','stopped','scaled')),
  meta_campaign_id TEXT,                             -- returned by Meta Ads API
  meta_ad_set_id   TEXT,
  error_message   TEXT,
  daily_budget_usd NUMERIC(10,2),
  creative_url    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cle_tenant_created  ON campaign_launch_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cle_cycle           ON campaign_launch_events (cycle_id) WHERE cycle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cle_status          ON campaign_launch_events (status);

-- ── 2. organic_publish_jobs — add 'dispatching' to allowed statuses ───────────
-- 'dispatching' is set atomically by OrganicSchedulerV61 before enqueueing to
-- ORGANIC_POSTING queue, preventing duplicate dispatch on clock skew / multi-instance.

DO $$
BEGIN
  -- PostgreSQL doesn't support ADD VALUE IF NOT EXISTS before 12.0,
  -- but we're not using ENUMs here — status is a TEXT column with CHECK.
  -- We need to update the CHECK constraint to include 'dispatching'.
  -- Safest approach: drop and re-add the constraint if it exists.

  ALTER TABLE organic_publish_jobs
    DROP CONSTRAINT IF EXISTS organic_publish_jobs_status_check;

  ALTER TABLE organic_publish_jobs
    ADD CONSTRAINT organic_publish_jobs_status_check
    CHECK (status IN ('scheduled','dispatching','publishing','published','failed'));

EXCEPTION WHEN undefined_table THEN
  NULL; -- table doesn't exist yet; migration 006 creates it
END;
$$;

-- Index to efficiently find stalled dispatching/publishing rows for recovery
CREATE INDEX IF NOT EXISTS idx_organic_jobs_stall
  ON organic_publish_jobs (status, updated_at)
  WHERE status IN ('dispatching', 'publishing');

-- ── 3. ai_provider_catalog — approved_by / approved_at columns ───────────────
-- Required by ProviderRequestService.review() when auto-seeding a new provider.

ALTER TABLE ai_provider_catalog
  ADD COLUMN IF NOT EXISTS approved_by  UUID,
  ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS description  TEXT;

-- ── 4. ai_provider_requests — ensure provider_url / docs_url exist ───────────
-- Migration 006 schema in the repo omits these columns; add defensively.

ALTER TABLE ai_provider_requests
  ADD COLUMN IF NOT EXISTS provider_url TEXT,
  ADD COLUMN IF NOT EXISTS docs_url     TEXT;

-- ── 5. user_ai_provider_connections — cost_usd column for usage events ────────
-- UserAiRouterService records cost_usd per event. Ensure the column exists on
-- user_ai_usage_events if migration 006 didn't include it.

ALTER TABLE user_ai_usage_events
  ADD COLUMN IF NOT EXISTS cost_usd  NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS latency_ms INT;

-- Index for top-consumers and quota-violation queries
CREATE INDEX IF NOT EXISTS idx_ai_usage_cost_tenant
  ON user_ai_usage_events (tenant_id, cost_usd DESC)
  WHERE cost_usd IS NOT NULL;

-- ── 6. Schema version record ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('007')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
