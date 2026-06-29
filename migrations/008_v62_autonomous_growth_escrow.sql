-- ============================================================
-- Migration 008 — V62 Autonomous Growth + Escrow Infrastructure
-- ============================================================
-- Adds tables for:
--   escrow_transactions         — centralized payment escrow
--   order_financial_breakdown   — per-order P&L (hidden from users)
--   supplier_fulfillment_tasks  — admin fulfillment workspace queue
--   supplier_checkout_sessions  — prefilled checkout metadata
--   growth_loop_events          — autonomous growth tracking
--   lifecycle_segments          — customer lifecycle buckets
--   lifecycle_campaigns         — automated lifecycle messages
--   churn_predictions           — ML churn risk per tenant/user
--   revenue_optimization_rules  — dynamic pricing/upsell rules
--   commerce_kpi_snapshots      — hourly ROAS/CAC/LTV snapshots
-- ============================================================

-- ── ENUMS ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE escrow_status AS ENUM (
    'PENDING_PAYMENT',
    'PAYMENT_VERIFIED',
    'ESCROW_CREATED',
    'AWAITING_SUPPLIER_PAYMENT',
    'SUPPLIER_PAYMENT_PROCESSING',
    'SUPPLIER_PAID',
    'SUPPLIER_FULFILLING',
    'TRACKING_RECEIVED',
    'SHIPPED',
    'DELIVERED',
    'FAILED',
    'REFUNDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fulfillment_supplier AS ENUM (
    'aliexpress', 'cjdropshipping', 'zendrop', 'autods', 'alibaba', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lifecycle_segment AS ENUM (
    'new_visitor', 'lead', 'first_purchase',
    'repeat_buyer', 'champion', 'at_risk', 'churned', 'win_back'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lifecycle_campaign_status AS ENUM (
    'queued', 'running', 'paused', 'completed', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE growth_event_type AS ENUM (
    'referral_click', 'referral_convert', 'viral_share',
    'upsell_trigger', 'bundle_trigger', 'winback_trigger',
    'organic_escalate', 'growth_loop_complete'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── ESCROW TRANSACTIONS ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS escrow_transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  razorpay_payment_id   VARCHAR(128),
  razorpay_order_id     VARCHAR(128),
  customer_paid_amount  NUMERIC(14,2) NOT NULL,
  razorpay_fee          NUMERIC(14,2) NOT NULL DEFAULT 0,
  supplier_product_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  supplier_shipping_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  admin_commission      NUMERIC(14,2) NOT NULL DEFAULT 0,
  user_profit           NUMERIC(14,2) GENERATED ALWAYS AS (
    customer_paid_amount
    - razorpay_fee
    - supplier_product_cost
    - supplier_shipping_cost
    - tax_amount
    - admin_commission
  ) STORED,
  currency              CHAR(3) NOT NULL DEFAULT 'INR',
  status                escrow_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  payment_verified_at   TIMESTAMPTZ,
  supplier_paid_at      TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  refunded_at           TIMESTAMPTZ,
  refund_reason         TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrow_tenant     ON escrow_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_escrow_order      ON escrow_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_escrow_status     ON escrow_transactions(status);
CREATE INDEX IF NOT EXISTS idx_escrow_created    ON escrow_transactions(created_at DESC);

-- ── SUPPLIER FULFILLMENT TASKS ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_fulfillment_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  escrow_id             UUID NOT NULL REFERENCES escrow_transactions(id),
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  supplier              fulfillment_supplier NOT NULL DEFAULT 'aliexpress',
  supplier_product_url  TEXT,
  supplier_variant_id   VARCHAR(255),
  checkout_autofill     JSONB NOT NULL DEFAULT '{}',  -- prefilled form data
  customer_name         VARCHAR(255),
  customer_email        VARCHAR(255),
  shipping_address      JSONB NOT NULL DEFAULT '{}',
  quantity              INTEGER NOT NULL DEFAULT 1,
  supplier_price        NUMERIC(14,2),
  supplier_shipping     NUMERIC(14,2),
  supplier_order_id     VARCHAR(255),
  tracking_number       VARCHAR(255),
  tracking_carrier      VARCHAR(100),
  tracking_url          TEXT,
  payment_proof_url     TEXT,         -- Telegram file_id or URL
  status                VARCHAR(64) NOT NULL DEFAULT 'AWAITING_ADMIN',
  admin_notes           TEXT,
  processed_by_admin    UUID,
  processed_at          TIMESTAMPTZ,
  marked_paid_at        TIMESTAMPTZ,
  tracking_synced_at    TIMESTAMPTZ,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_tenant  ON supplier_fulfillment_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_status  ON supplier_fulfillment_tasks(status);
CREATE INDEX IF NOT EXISTS idx_fulfillment_escrow  ON supplier_fulfillment_tasks(escrow_id);

-- ── SUPPLIER CHECKOUT SESSIONS ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_checkout_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id  UUID NOT NULL REFERENCES supplier_fulfillment_tasks(id),
  supplier        fulfillment_supplier NOT NULL,
  checkout_url    TEXT NOT NULL,
  autofill_data   JSONB NOT NULL DEFAULT '{}',
  opened_by_admin UUID,
  opened_at       TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 hours'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkout_fulfillment ON supplier_checkout_sessions(fulfillment_id);

-- ── GROWTH LOOP EVENTS ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS growth_loop_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  user_id         UUID REFERENCES users(id),
  event_type      growth_event_type NOT NULL,
  source_channel  VARCHAR(64),           -- organic|paid|referral|whatsapp|email
  campaign_id     UUID,
  product_id      UUID REFERENCES products(id),
  attributed_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  loop_depth      INTEGER NOT NULL DEFAULT 1,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_growth_tenant   ON growth_loop_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_growth_type     ON growth_loop_events(event_type);
CREATE INDEX IF NOT EXISTS idx_growth_created  ON growth_loop_events(created_at DESC);

-- ── CUSTOMER LIFECYCLE SEGMENTS ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lifecycle_customer_segments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  customer_email      VARCHAR(255) NOT NULL,
  customer_name       VARCHAR(255),
  segment             lifecycle_segment NOT NULL DEFAULT 'new_visitor',
  total_orders        INTEGER NOT NULL DEFAULT 0,
  total_revenue       NUMERIC(14,2) NOT NULL DEFAULT 0,
  avg_order_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
  ltv_score           NUMERIC(8,4) NOT NULL DEFAULT 0,
  churn_risk_score    NUMERIC(5,4) NOT NULL DEFAULT 0,   -- 0.0–1.0
  last_purchase_at    TIMESTAMPTZ,
  days_since_purchase INTEGER,
  rfm_recency         INTEGER,  -- days
  rfm_frequency       INTEGER,  -- count
  rfm_monetary        NUMERIC(14,2),
  predicted_ltv_90d   NUMERIC(14,2),
  tags                TEXT[] NOT NULL DEFAULT '{}',
  metadata            JSONB NOT NULL DEFAULT '{}',
  segmented_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, customer_email)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_tenant   ON lifecycle_customer_segments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_segment  ON lifecycle_customer_segments(segment);
CREATE INDEX IF NOT EXISTS idx_lifecycle_churn    ON lifecycle_customer_segments(churn_risk_score DESC);

-- ── LIFECYCLE CAMPAIGNS ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lifecycle_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  name            VARCHAR(255) NOT NULL,
  trigger_segment lifecycle_segment NOT NULL,
  trigger_event   VARCHAR(64),   -- 'purchase', 'cart_abandon', 'inactivity', 'churn_risk'
  channel         VARCHAR(32) NOT NULL DEFAULT 'email',  -- email|whatsapp|sms
  subject         TEXT,
  body_template   TEXT NOT NULL,
  cta_url         TEXT,
  delay_hours     INTEGER NOT NULL DEFAULT 0,
  status          lifecycle_campaign_status NOT NULL DEFAULT 'queued',
  sends_total     INTEGER NOT NULL DEFAULT 0,
  opens_total     INTEGER NOT NULL DEFAULT 0,
  clicks_total    INTEGER NOT NULL DEFAULT 0,
  conversions     INTEGER NOT NULL DEFAULT 0,
  revenue_attr    NUMERIC(14,2) NOT NULL DEFAULT 0,
  ai_generated    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lc_campaign_tenant ON lifecycle_campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lc_campaign_seg    ON lifecycle_campaigns(trigger_segment);

-- ── CHURN PREDICTIONS ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS churn_predictions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  customer_email  VARCHAR(255) NOT NULL,
  churn_score     NUMERIC(5,4) NOT NULL,  -- 0.0–1.0 probability of churn
  risk_tier       VARCHAR(16) NOT NULL,   -- 'high'|'medium'|'low'
  top_signals     JSONB NOT NULL DEFAULT '[]',  -- [{signal,weight}]
  recommended_action VARCHAR(128),
  predicted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actioned_at     TIMESTAMPTZ,
  UNIQUE (tenant_id, customer_email)
);

CREATE INDEX IF NOT EXISTS idx_churn_tenant ON churn_predictions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_churn_score  ON churn_predictions(churn_score DESC);

-- ── REVENUE OPTIMIZATION RULES ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS revenue_optimization_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  rule_type       VARCHAR(64) NOT NULL,   -- 'bundle'|'upsell'|'dynamic_price'|'free_shipping_threshold'
  trigger_context JSONB NOT NULL DEFAULT '{}',
  action_config   JSONB NOT NULL DEFAULT '{}',
  priority        INTEGER NOT NULL DEFAULT 100,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  ab_variant      VARCHAR(8),
  conversion_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
  revenue_lift    NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revopt_tenant ON revenue_optimization_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_revopt_type   ON revenue_optimization_rules(rule_type);

-- ── COMMERCE KPI SNAPSHOTS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS commerce_kpi_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period          VARCHAR(16) NOT NULL DEFAULT 'hourly',  -- 'hourly'|'daily'|'weekly'
  roas            NUMERIC(8,4),
  cac             NUMERIC(10,2),
  ltv_30d         NUMERIC(10,2),
  ltv_90d         NUMERIC(10,2),
  ctr             NUMERIC(6,4),
  conversion_rate NUMERIC(6,4),
  aov             NUMERIC(10,2),
  gross_revenue   NUMERIC(14,2),
  net_profit      NUMERIC(14,2),
  ad_spend        NUMERIC(14,2),
  orders_count    INTEGER,
  new_customers   INTEGER,
  repeat_customers INTEGER,
  churn_rate      NUMERIC(6,4),
  virality_score  NUMERIC(6,4),
  metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_kpi_tenant   ON commerce_kpi_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kpi_snapshot ON commerce_kpi_snapshots(snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_kpi_period   ON commerce_kpi_snapshots(tenant_id, period, snapshot_at DESC);

-- ── TRIGGERS: updated_at ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_escrow_updated_at
    BEFORE UPDATE ON escrow_transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_fulfillment_updated_at
    BEFORE UPDATE ON supplier_fulfillment_tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_lifecycle_segment_updated_at
    BEFORE UPDATE ON lifecycle_customer_segments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_lc_campaign_updated_at
    BEFORE UPDATE ON lifecycle_campaigns
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_revopt_updated_at
    BEFORE UPDATE ON revenue_optimization_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
