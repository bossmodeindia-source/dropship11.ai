-- ═══════════════════════════════════════════════════════════════════════════
-- V67 Enterprise Certification Migration
-- Pipeline Table Formalization + TypeORM Removal Cleanup
-- ═══════════════════════════════════════════════════════════════════════════
-- Applies on top of v66-enterprise-hardening.sql
-- Safe to run multiple times (all DDL uses IF NOT EXISTS)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PIPELINE TABLES (formerly TypeORM entities) ─────────────────────────
-- These tables were managed by TypeORM in V66 and earlier.
-- V67: TypeORM removed. Tables are now defined in Drizzle schema.ts.
-- This migration creates them if they don't exist (idempotent).

CREATE TABLE IF NOT EXISTS creatives (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID         NOT NULL,
  hook            TEXT         NOT NULL,
  type            VARCHAR(20)  NOT NULL DEFAULT 'image'
                               CHECK (type IN ('video','image')),
  score           FLOAT        NOT NULL DEFAULT 0,
  predicted_ctr   FLOAT        NOT NULL DEFAULT 0,
  predicted_cvr   FLOAT        NOT NULL DEFAULT 0,
  confidence      FLOAT        NOT NULL DEFAULT 0,
  status          VARCHAR(20)  NOT NULL DEFAULT 'testing'
                               CHECK (status IN ('testing','active','killed','paused','winner')),
  asset_url       TEXT,
  metadata        JSONB        NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creatives_product_status ON creatives (product_id, status);
CREATE INDEX IF NOT EXISTS idx_creatives_status_score   ON creatives (status, score DESC);

CREATE TABLE IF NOT EXISTS creative_performance (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id  UUID         NOT NULL
               REFERENCES creatives(id) ON DELETE CASCADE ON UPDATE CASCADE,
  impressions  BIGINT       NOT NULL DEFAULT 0,
  clicks       BIGINT       NOT NULL DEFAULT 0,
  conversions  BIGINT       NOT NULL DEFAULT 0,
  ctr          FLOAT        NOT NULL DEFAULT 0,
  cpc          FLOAT        NOT NULL DEFAULT 0,
  roas         FLOAT        NOT NULL DEFAULT 0,
  spend        FLOAT        NOT NULL DEFAULT 0,
  revenue      FLOAT        NOT NULL DEFAULT 0,
  frequency    FLOAT,
  reach        FLOAT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perf_creative ON creative_performance (creative_id);
CREATE INDEX IF NOT EXISTS idx_perf_roas     ON creative_performance (roas DESC);

CREATE TABLE IF NOT EXISTS learning_data (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_type      VARCHAR(50)  NOT NULL CHECK (creative_type IN ('video','image')),
  hook               TEXT         NOT NULL,
  niche              VARCHAR(100) NOT NULL,
  platform           VARCHAR(50)  NOT NULL DEFAULT 'instagram',
  ctr                FLOAT        NOT NULL,
  cvr                FLOAT        NOT NULL DEFAULT 0,
  roas               FLOAT        NOT NULL,
  hook_strength      FLOAT        NOT NULL DEFAULT 5,
  source_creative_id UUID,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_niche_type  ON learning_data (niche, creative_type);
CREATE INDEX IF NOT EXISTS idx_learning_roas        ON learning_data (roas DESC);

CREATE TABLE IF NOT EXISTS bandit_sessions (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key      VARCHAR(100) NOT NULL,
  product_id       UUID         NOT NULL,
  total_budget     FLOAT        NOT NULL,
  remaining_budget FLOAT        NOT NULL DEFAULT 0,
  round            INTEGER      NOT NULL DEFAULT 0,
  winner_creative_id UUID,
  arms_snapshot    JSONB,
  status           VARCHAR(20)  NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','completed','aborted')),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bandit_product ON bandit_sessions (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key                VARCHAR(100) NOT NULL,
  product_id             UUID         NOT NULL,
  status                 VARCHAR(30)  NOT NULL,
  creatives_generated    INTEGER      NOT NULL DEFAULT 0,
  creatives_passed_filter INTEGER     NOT NULL DEFAULT 0,
  winner_creative_id     UUID,
  final_roas             FLOAT        NOT NULL DEFAULT 0,
  total_spend            FLOAT        NOT NULL DEFAULT 0,
  total_revenue          FLOAT        NOT NULL DEFAULT 0,
  profit                 FLOAT        NOT NULL DEFAULT 0,
  duration_ms            INTEGER      NOT NULL DEFAULT 0,
  next_action            VARCHAR(50)  NOT NULL,
  error                  TEXT,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_product ON pipeline_runs (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_status  ON pipeline_runs (status);

-- ─── 2. CHECK CONSTRAINTS on pipeline tables ──────────────────────────────────
ALTER TABLE creatives
  DROP CONSTRAINT IF EXISTS chk_creative_score_positive;
ALTER TABLE creatives
  ADD CONSTRAINT chk_creative_score_positive CHECK (score >= 0);

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS chk_pipeline_roas_positive;
ALTER TABLE pipeline_runs
  ADD CONSTRAINT chk_pipeline_roas_positive CHECK (final_roas >= 0 AND total_spend >= 0 AND total_revenue >= 0);

-- ─── 3. EXTEND FINANCIAL AUDIT TRIGGER to pipeline tables ────────────────────
DO $$
BEGIN
  -- pipeline_runs: track all run status changes (financial accountability)
  EXECUTE '
    DROP TRIGGER IF EXISTS trg_audit_pipeline_runs ON pipeline_runs;
    CREATE TRIGGER trg_audit_pipeline_runs
      AFTER INSERT OR UPDATE OR DELETE ON pipeline_runs
      FOR EACH ROW EXECUTE FUNCTION fn_financial_audit();
  ';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE ''Skipping pipeline_runs trigger: %'', SQLERRM;
END $$;

-- ─── 4. TYPEORM CLEANUP ────────────────────────────────────────────────────────
-- Drop any TypeORM metadata tables if they exist from previous installations
-- (typeorm creates __migrations and entity_metadata tables in some configs)
DROP TABLE IF EXISTS typeorm_metadata CASCADE;

-- ─── 5. RECORD V67 MIGRATION ─────────────────────────────────────────────────
INSERT INTO schema_migrations (version, description)
VALUES (
  'v67-typeorm-removal',
  'V67 Enterprise Certification: TypeORM removed, pipeline tables formalized in Drizzle, single schema source of truth'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
