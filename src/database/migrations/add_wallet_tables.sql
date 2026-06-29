-- Migration: add_wallet_tables
-- Run after v62 escrow migration
-- ─────────────────────────────────────────────────────────────────────────────

-- Enums
DO $$ BEGIN
  CREATE TYPE wallet_tx_type AS ENUM (
    'REFUND', 'PROFIT_CREDIT', 'WITHDRAWAL', 'ADJUSTMENT', 'BONUS'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_tx_status AS ENUM (
    'PENDING', 'COMPLETED', 'FAILED', 'REVERSED'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Wallet balances (one row per user)
CREATE TABLE IF NOT EXISTS wallet_balances (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance     NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  currency    VARCHAR(3)     NOT NULL DEFAULT 'INR',
  version     INTEGER        NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_balances_user_id ON wallet_balances(user_id);

-- Wallet transactions (append-only ledger)
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                wallet_tx_type   NOT NULL,
  status              wallet_tx_status NOT NULL DEFAULT 'COMPLETED',
  amount              NUMERIC(14, 2)   NOT NULL,  -- positive=credit, negative=debit
  balance_after       NUMERIC(14, 2)   NOT NULL,
  currency            VARCHAR(3)       NOT NULL DEFAULT 'INR',
  order_id            UUID,
  escrow_id           UUID,
  razorpay_refund_id  VARCHAR(128),
  stripe_refund_id    VARCHAR(128),
  description         TEXT NOT NULL,
  gateway_payment_id  VARCHAR(128),
  gateway_provider    VARCHAR(32),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_id   ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_order_id  ON wallet_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created_at ON wallet_transactions(created_at DESC);

-- Add 'refunded' to order_status enum if not already present
DO $$ BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'refunded';
EXCEPTION WHEN others THEN null; END $$;
