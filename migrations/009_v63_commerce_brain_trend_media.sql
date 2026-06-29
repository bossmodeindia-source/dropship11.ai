-- ============================================================
-- Migration 009 — CommerceBrain + TrendIntelligence + ViralMediaEngine + SupplierRouting
-- ============================================================
-- Adds tables for:
--   brain_memory              — consolidated AI learning knowledge
--   brain_learning_signals    — raw per-event learning ring buffer
--   brain_decisions           — audit log of all Brain decisions
--   commerce_plans            — full CommercePlan records per cycle
--   trend_signals             — platform trend signal harvest
--   viral_media_jobs          — viral media pipeline job tracking
--   supplier_routing_log      — per-order routing decisions
--   supplier_scores           — supplier reliability EMA scores
--   supplier_routing_overrides — admin supplier routing overrides
-- ============================================================

-- ── ENUMS ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE brain_memory_category AS ENUM (
    'winning_creative',
    'failing_creative',
    'viral_hook',
    'profitable_audience',
    'supplier_reliability',
    'roas_history',
    'viral_pattern',
    'platform_engagement',
    'campaign_failure',
    'high_converting_page',
    'seo_signal',
    'ai_discoverability'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE commerce_plan_status AS ENUM (
    'draft', 'approved', 'executing', 'completed', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trend_platform AS ENUM (
    'google', 'tiktok', 'meta', 'reddit', 'amazon', 'shopify', 'youtube'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE viral_media_job_status AS ENUM (
    'queued', 'trend_discovery', 'script_generation',
    'image_generation', 'video_generation', 'voice_generation',
    'assembly', 'scoring', 'variants', 'publishing',
    'completed', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── brain_memory ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_memory (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  category       brain_memory_category NOT NULL,
  memory_key     VARCHAR(512) NOT NULL,
  value          JSONB NOT NULL DEFAULT '{}',
  success_score  NUMERIC(5,4) NOT NULL DEFAULT 0,
  hit_count      INTEGER NOT NULL DEFAULT 1,
  platform       VARCHAR(64),
  niche          VARCHAR(128),
  geography      VARCHAR(64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brain_memory_unique_key UNIQUE (tenant_id, category, memory_key)
);

CREATE INDEX IF NOT EXISTS brain_memory_tenant_idx   ON brain_memory(tenant_id);
CREATE INDEX IF NOT EXISTS brain_memory_category_idx ON brain_memory(category);
CREATE INDEX IF NOT EXISTS brain_memory_score_idx    ON brain_memory(success_score DESC);

-- ── brain_learning_signals ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_learning_signals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  category       brain_memory_category NOT NULL,
  memory_key     VARCHAR(512) NOT NULL,
  value          JSONB NOT NULL DEFAULT '{}',
  success_score  NUMERIC(5,4) NOT NULL,
  platform       VARCHAR(64),
  niche          VARCHAR(128),
  geography      VARCHAR(64),
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brain_signals_tenant_idx   ON brain_learning_signals(tenant_id);
CREATE INDEX IF NOT EXISTS brain_signals_category_idx ON brain_learning_signals(category);
CREATE INDEX IF NOT EXISTS brain_signals_created_idx  ON brain_learning_signals(created_at DESC);

-- Partition by month for large-scale operations (manual; adjust for your PostgreSQL version)
-- Signals older than 90 days can be archived via a scheduled job

-- ── brain_decisions ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_decisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  brain_type  VARCHAR(64) NOT NULL,
  decision    TEXT NOT NULL,
  reasoning   TEXT,
  confidence  NUMERIC(5,4),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brain_decisions_tenant_idx  ON brain_decisions(tenant_id);
CREATE INDEX IF NOT EXISTS brain_decisions_type_idx    ON brain_decisions(brain_type);
CREATE INDEX IF NOT EXISTS brain_decisions_created_idx ON brain_decisions(created_at DESC);

-- ── commerce_plans ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS commerce_plans (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  cycle_started_at     TIMESTAMPTZ NOT NULL,
  trend_signals        JSONB NOT NULL DEFAULT '[]',
  product_decisions    JSONB NOT NULL DEFAULT '[]',
  audience_profiles    JSONB NOT NULL DEFAULT '[]',
  creative_directions  JSONB NOT NULL DEFAULT '[]',
  pricing_recs         JSONB NOT NULL DEFAULT '[]',
  growth_loops         JSONB NOT NULL DEFAULT '[]',
  estimated_roas       NUMERIC(8,4) NOT NULL DEFAULT 0,
  confidence           NUMERIC(5,4) NOT NULL DEFAULT 0,
  plan_status          commerce_plan_status NOT NULL DEFAULT 'draft',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS commerce_plans_tenant_idx  ON commerce_plans(tenant_id);
CREATE INDEX IF NOT EXISTS commerce_plans_status_idx  ON commerce_plans(plan_status);
CREATE INDEX IF NOT EXISTS commerce_plans_created_idx ON commerce_plans(cycle_started_at DESC);

-- ── trend_signals ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trend_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform      trend_platform NOT NULL,
  keyword       VARCHAR(256) NOT NULL,
  trend_score   NUMERIC(6,2) NOT NULL,
  velocity      NUMERIC(8,2) NOT NULL DEFAULT 0,
  saturation    NUMERIC(5,4) NOT NULL DEFAULT 0,
  related_terms JSONB NOT NULL DEFAULT '[]',
  category      VARCHAR(128),
  geography     VARCHAR(8) NOT NULL DEFAULT 'IN',
  raw_data      JSONB NOT NULL DEFAULT '{}',
  captured_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trend_signals_platform_idx ON trend_signals(platform);
CREATE INDEX IF NOT EXISTS trend_signals_keyword_idx  ON trend_signals(keyword);
CREATE INDEX IF NOT EXISTS trend_signals_score_idx    ON trend_signals(trend_score DESC);
CREATE INDEX IF NOT EXISTS trend_signals_captured_idx ON trend_signals(captured_at DESC);

-- Auto-delete signals older than 30 days (managed by a scheduled job or pg_partman)
-- CREATE RULE trend_signals_expiry AS ON INSERT TO trend_signals DO DELETE FROM trend_signals WHERE captured_at < NOW() - INTERVAL '30 days';

-- ── viral_media_jobs ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS viral_media_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  user_id          UUID NOT NULL,
  product_id       UUID,
  media_type       VARCHAR(64) NOT NULL,
  target_platforms JSONB NOT NULL DEFAULT '[]',
  variant_count    INTEGER NOT NULL DEFAULT 1,
  auto_publish     BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key  VARCHAR(512) NOT NULL UNIQUE,
  status           viral_media_job_status NOT NULL DEFAULT 'queued',
  assets           JSONB NOT NULL DEFAULT '[]',
  virality_scores  JSONB NOT NULL DEFAULT '[]',
  published_urls   JSONB NOT NULL DEFAULT '[]',
  estimated_roas   NUMERIC(8,4) NOT NULL DEFAULT 0,
  error_message    VARCHAR(2048),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS viral_media_tenant_idx  ON viral_media_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS viral_media_status_idx  ON viral_media_jobs(status);
CREATE INDEX IF NOT EXISTS viral_media_created_idx ON viral_media_jobs(created_at DESC);

-- ── supplier_routing_log ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_routing_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL,
  tenant_id      UUID NOT NULL,
  selected       VARCHAR(64) NOT NULL,
  fallbacks      JSONB NOT NULL DEFAULT '[]',
  score          NUMERIC(6,4),
  reasoning      VARCHAR(512),
  landed_cost    NUMERIC(10,2),
  estimated_days INTEGER,
  candidate_data JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supplier_routing_order_idx  ON supplier_routing_log(order_id);
CREATE INDEX IF NOT EXISTS supplier_routing_tenant_idx ON supplier_routing_log(tenant_id);

-- ── supplier_scores ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_scores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier          VARCHAR(64) NOT NULL UNIQUE,
  current_score     NUMERIC(6,2) NOT NULL DEFAULT 70,
  total_orders      INTEGER NOT NULL DEFAULT 0,
  successful_orders INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default scores
INSERT INTO supplier_scores (supplier, current_score) VALUES
  ('aliexpress',     65),
  ('cjdropshipping', 75),
  ('zendrop',        80),
  ('autods',         72),
  ('alibaba',        60),
  ('custom',         70)
ON CONFLICT (supplier) DO NOTHING;

-- ── supplier_routing_overrides ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_routing_overrides (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  preferred_supplier   VARCHAR(64) NOT NULL,
  niche                VARCHAR(128),
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id  UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supplier_overrides_tenant_idx ON supplier_routing_overrides(tenant_id);

-- ── updated_at auto-maintenance triggers ─────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DO $$ BEGIN
  CREATE TRIGGER brain_memory_updated_at
    BEFORE UPDATE ON brain_memory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER commerce_plans_updated_at
    BEFORE UPDATE ON commerce_plans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER viral_media_jobs_updated_at
    BEFORE UPDATE ON viral_media_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER supplier_scores_updated_at
    BEFORE UPDATE ON supplier_scores
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
