-- ============================================================================
-- AI Empire — V60 Enterprise Stabilization Migration
-- New tables for: UnifiedCommerceOrchestrator, UnifiedFinanceEngine
--
-- Run order: AFTER 001_payment_system.sql
-- Idempotent: all CREATE TABLE uses IF NOT EXISTS
-- Safe to re-run: uses IF NOT EXISTS + DO $$ EXCEPTION patterns
-- ============================================================================

BEGIN;

-- ── commerce_cycles ──────────────────────────────────────────────────────────
-- Persists every commerce cycle state for crash recovery.
-- Written by UnifiedCommerceOrchestrator on every step transition.
-- DisasterRecoveryService scans this table on startup for stale 'running' cycles.

CREATE TABLE IF NOT EXISTS commerce_cycles (
  id          VARCHAR(36)   PRIMARY KEY,
  bot_id      VARCHAR(36)   NOT NULL,
  tenant_id   VARCHAR(36)   NOT NULL,
  status      VARCHAR(20)   NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','completed','failed','paused')),
  steps       TEXT          NOT NULL DEFAULT '{}',
  started_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_cycles_tenant_bot
  ON commerce_cycles (tenant_id, bot_id);

CREATE INDEX IF NOT EXISTS idx_commerce_cycles_status
  ON commerce_cycles (status) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_commerce_cycles_started_at
  ON commerce_cycles (started_at);

COMMENT ON TABLE  commerce_cycles            IS 'V60: UnifiedCommerceOrchestrator cycle state. Used for crash recovery.';
COMMENT ON COLUMN commerce_cycles.steps      IS 'JSON map of step_name → {status, result, error, ts}';
COMMENT ON COLUMN commerce_cycles.status     IS 'running|completed|failed|paused';

-- ── revenue_events ───────────────────────────────────────────────────────────
-- Idempotent revenue recording. orderId is the dedup key.
-- SECURITY: admin_commission is INTERNAL — never expose in user-facing APIs.
-- Use UnifiedFinanceEngine.getUserFacingSnapshot() which strips it automatically.

CREATE TABLE IF NOT EXISTS revenue_events (
  id               VARCHAR(100)       PRIMARY KEY,  -- 'rev:{orderId}'
  tenant_id        VARCHAR(36)        NOT NULL,
  bot_id           VARCHAR(36)        NOT NULL,
  order_id         VARCHAR(100)       NOT NULL UNIQUE,
  shopify_order_id VARCHAR(100),
  gross_revenue    NUMERIC(14,2)      NOT NULL CHECK (gross_revenue >= 0),
  admin_commission NUMERIC(14,2)      NOT NULL DEFAULT 0 CHECK (admin_commission >= 0),
  net_revenue      NUMERIC(14,2)      NOT NULL,
  currency         VARCHAR(10)        NOT NULL DEFAULT 'INR',
  product_id       VARCHAR(100),
  cycle_id         VARCHAR(36),
  recorded_at      TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_events_tenant_bot_date
  ON revenue_events (tenant_id, bot_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_revenue_events_order_id
  ON revenue_events (order_id);

COMMENT ON TABLE  revenue_events                 IS 'V60: UnifiedFinanceEngine revenue tracking. orderId = idempotency key.';
COMMENT ON COLUMN revenue_events.admin_commission IS 'INTERNAL ONLY. Never return in user-facing responses.';

-- ── cost_events ───────────────────────────────────────────────────────────────
-- Idempotent cost recording. cycle_id or campaign_id is the dedup key.

CREATE TABLE IF NOT EXISTS cost_events (
  id            VARCHAR(100)   PRIMARY KEY,  -- 'cost:{cycleId|campaignId}'
  tenant_id     VARCHAR(36)    NOT NULL,
  bot_id        VARCHAR(36)    NOT NULL,
  campaign_id   VARCHAR(100),
  cycle_id      VARCHAR(36),
  ad_spend      NUMERIC(14,2)  NOT NULL DEFAULT 0 CHECK (ad_spend >= 0),
  supplier_cost NUMERIC(14,2)  NOT NULL DEFAULT 0 CHECK (supplier_cost >= 0),
  platform_fees NUMERIC(14,2)  NOT NULL DEFAULT 0 CHECK (platform_fees >= 0),
  total_cost    NUMERIC(14,2)  NOT NULL DEFAULT 0,
  currency      VARCHAR(10)    NOT NULL DEFAULT 'INR',
  recorded_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cost_events_tenant_bot_date
  ON cost_events (tenant_id, bot_id, recorded_at);

COMMENT ON TABLE cost_events IS 'V60: UnifiedFinanceEngine cost tracking. cycle_id or campaign_id = idempotency key.';

-- ── commission_configs ───────────────────────────────────────────────────────
-- Per-tenant admin commission configuration.
-- SECURITY: Contents are ADMIN-ONLY. No user-facing endpoint may read this table.

CREATE TABLE IF NOT EXISTS commission_configs (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(36)    NOT NULL UNIQUE,
  commission_rate NUMERIC(5,4)   NOT NULL DEFAULT 0.15
                                 CHECK (commission_rate >= 0 AND commission_rate < 1),
  minimum_flat    NUMERIC(14,2)  NOT NULL DEFAULT 0 CHECK (minimum_flat >= 0),
  currency        VARCHAR(10)    NOT NULL DEFAULT 'INR',
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  commission_configs                 IS 'V60: Admin commission config per tenant. NEVER expose to users.';
COMMENT ON COLUMN commission_configs.commission_rate IS '0.15 = 15%. Range: 0.00–0.99';

-- ── Auto-updated updated_at trigger for commerce_cycles ──────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DO $$ BEGIN
  CREATE TRIGGER update_commerce_cycles_updated_at
    BEFORE UPDATE ON commerce_cycles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER update_commission_configs_updated_at
    BEFORE UPDATE ON commission_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Default commission config for existing tenants ────────────────────────────
-- Inserts a default 15% config for any tenant that doesn't have one yet.
-- Safe to run repeatedly (ON CONFLICT DO NOTHING).

INSERT INTO commission_configs (tenant_id, commission_rate, minimum_flat, currency)
SELECT DISTINCT id::VARCHAR, 0.15, 0, 'INR'
FROM users
WHERE role = 'admin'
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────────
-- After running, verify with:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('commerce_cycles','revenue_events','cost_events','commission_configs');
-- Expected: 4 rows
