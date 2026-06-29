-- ============================================================================
-- AI Empire — Payment System Migration
-- V59 Payment Infrastructure: Withdrawals, Subscriptions, Finance Snapshots
--
-- Run order: this file after the existing V59 schema.sql
-- Idempotent: all CREATE TABLE uses IF NOT EXISTS
-- ============================================================================

BEGIN;

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE withdrawal_status AS ENUM (
    'pending', 'approved', 'rejected', 'completed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE subscription_plan AS ENUM ('free', 'pro', 'elite');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Withdrawals ───────────────────────────────────────────────────────────────
-- Manual admin-controlled withdrawal requests.
-- Bank details are AES-256-GCM encrypted — ciphertext + iv + tag per field.

CREATE TABLE IF NOT EXISTS withdrawals (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant isolation (NEVER omit from queries)
  tenant_id                       UUID        NOT NULL,
  user_id                         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  amount                          NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency                        VARCHAR(10) NOT NULL DEFAULT 'INR',

  status                          withdrawal_status NOT NULL DEFAULT 'pending',

  -- Bank info (unencrypted) — safe to display
  bank_name                       VARCHAR(255) NOT NULL,

  -- AES-256-GCM encrypted bank fields — NEVER log or return unencrypted
  account_holder_name_ciphertext  TEXT NOT NULL,
  account_holder_name_iv          TEXT NOT NULL,
  account_holder_name_tag         TEXT NOT NULL,

  account_number_ciphertext       TEXT NOT NULL,
  account_number_iv               TEXT NOT NULL,
  account_number_tag              TEXT NOT NULL,

  ifsc_code_ciphertext            TEXT NOT NULL,
  ifsc_code_iv                    TEXT NOT NULL,
  ifsc_code_tag                   TEXT NOT NULL,

  -- Fraud snapshot — captured at request time
  pending_orders_at_request       INTEGER NOT NULL DEFAULT 0,

  -- Admin workflow
  admin_notes                     TEXT,
  reviewed_by                     UUID REFERENCES users(id) ON DELETE SET NULL,
  is_frozen                       BOOLEAN NOT NULL DEFAULT FALSE,
  frozen_reason                   TEXT,

  -- Razorpay payout reference (optional — for audit trail)
  razorpay_payout_id              VARCHAR(255),

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at                    TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common admin queries
CREATE INDEX IF NOT EXISTS idx_withdrawals_tenant_id  ON withdrawals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id    ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status     ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at ON withdrawals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_tenant_status ON withdrawals(tenant_id, status);

-- ── Supplier Payments — extend existing supplier_payments table ────────────────
-- Add internal cost columns (admin-only, never returned to users)

ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS supplier_base_price  NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS commission_amount     NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS tenant_id             UUID,
  ADD COLUMN IF NOT EXISTS user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paid_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes                 TEXT;

CREATE INDEX IF NOT EXISTS idx_supplier_payments_tenant_id ON supplier_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_user_id   ON supplier_payments(user_id);

-- ── User Subscriptions ────────────────────────────────────────────────────────
-- Platform Razorpay billing. Users do NOT own Razorpay accounts.

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id                 UUID        NOT NULL,
  user_id                   UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  plan                      subscription_plan NOT NULL DEFAULT 'free',
  status                    VARCHAR(50) NOT NULL DEFAULT 'active',

  -- Platform Razorpay identifiers
  razorpay_customer_id      VARCHAR(255),
  razorpay_subscription_id  VARCHAR(255),
  razorpay_plan_id          VARCHAR(255),

  current_period_start      TIMESTAMPTZ,
  current_period_end        TIMESTAMPTZ,
  cancel_at_period_end      BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Plan feature limits (denormalized for fast reads)
  max_bots                  INTEGER     NOT NULL DEFAULT 1,
  ads_enabled               BOOLEAN     NOT NULL DEFAULT FALSE,
  advanced_automation       BOOLEAN     NOT NULL DEFAULT FALSE,

  monthly_amount_inr        NUMERIC(12, 2) NOT NULL DEFAULT 0,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_tenant_id   ON user_subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_rzpay_sub   ON user_subscriptions(razorpay_subscription_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan_status ON user_subscriptions(plan, status);

-- ── Razorpay Webhook Events ───────────────────────────────────────────────────
-- Idempotency store — prevents duplicate processing of webhook events.

CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      VARCHAR(255) NOT NULL UNIQUE,  -- Razorpay event ID
  event_type    VARCHAR(100) NOT NULL,
  payload       JSONB       NOT NULL,
  processed     BOOLEAN     NOT NULL DEFAULT FALSE,
  processed_at  TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_razorpay_events_event_id ON razorpay_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_razorpay_events_processed ON razorpay_webhook_events(processed);

-- ── Platform Finance Snapshots ────────────────────────────────────────────────
-- Append-only daily P&L snapshots per tenant.
-- Written nightly by FinanceSnapshotScheduler.

CREATE TABLE IF NOT EXISTS platform_finance_snapshots (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL,

  snapshot_date         TIMESTAMPTZ NOT NULL,

  total_revenue         NUMERIC(16, 2) NOT NULL DEFAULT 0,
  supplier_costs        NUMERIC(16, 2) NOT NULL DEFAULT 0,
  platform_commissions  NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ad_spend              NUMERIC(16, 2) NOT NULL DEFAULT 0,
  estimated_net_profit  NUMERIC(16, 2) NOT NULL DEFAULT 0,

  fulfilled_orders      INTEGER     NOT NULL DEFAULT 0,
  pending_orders        INTEGER     NOT NULL DEFAULT 0,
  total_orders          INTEGER     NOT NULL DEFAULT 0,

  total_withdrawn       NUMERIC(16, 2) NOT NULL DEFAULT 0,
  pending_payouts       NUMERIC(16, 2) NOT NULL DEFAULT 0,

  subscription_revenue  NUMERIC(16, 2) NOT NULL DEFAULT 0,

  metadata              JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finance_snapshots_tenant_date
  ON platform_finance_snapshots(tenant_id, snapshot_date DESC);

-- ── Orders table extensions ────────────────────────────────────────────────────
-- Add commission_amount column to orders for finance tracking

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS commission_amount  NUMERIC(14, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_cost      NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS tenant_id          UUID;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_status ON orders(tenant_id, status);

-- ── Row-Level Security (RLS) — tenant isolation ────────────────────────────────
-- Enable RLS on all financial tables for defense-in-depth.
-- Application layer ALWAYS filters by tenant_id too.

ALTER TABLE withdrawals                ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_subscriptions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_finance_snapshots ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (used by NestJS app pool)
-- Policies are enforced for reporting/analytics direct DB access only.
-- The NestJS app uses parameterized queries with tenant_id WHERE clause always.

-- ── Audit log extensions ───────────────────────────────────────────────────────
-- Ensure audit_logs covers new financial action types

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'withdrawal.requested';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'withdrawal.approved';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'withdrawal.rejected';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'withdrawal.completed';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'withdrawal.frozen';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'withdrawal.bank_detail_decrypted';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'supplier_payment.confirmed';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'subscription.created';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'subscription.cancelled';
EXCEPTION WHEN others THEN
  -- Enum may not exist in this schema version — create a fallback log
  RAISE NOTICE 'audit_action enum extension skipped: %', SQLERRM;
END $$;

-- ── Updated_at triggers ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER withdrawals_updated_at
    BEFORE UPDATE ON withdrawals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER user_subscriptions_updated_at
    BEFORE UPDATE ON user_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- ── Verification ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  missing_tables TEXT[] := ARRAY[]::TEXT[];
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'withdrawals',
    'user_subscriptions',
    'razorpay_webhook_events',
    'platform_finance_snapshots'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = tbl AND table_schema = 'public'
    ) THEN
      missing_tables := array_append(missing_tables, tbl);
    END IF;
  END LOOP;

  IF array_length(missing_tables, 1) > 0 THEN
    RAISE EXCEPTION 'Migration incomplete — missing tables: %', array_to_string(missing_tables, ', ');
  ELSE
    RAISE NOTICE '✅ Payment system migration complete. All tables present.';
  END IF;
END $$;
