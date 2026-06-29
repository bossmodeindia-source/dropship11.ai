-- ═══════════════════════════════════════════════════════════════════════════
-- V66 Enterprise Certification Migration
-- Database Hardening: Foreign Keys, Constraints, Audit Triggers
-- ═══════════════════════════════════════════════════════════════════════════
-- Run: node src/database/migrations/run-v66-migrations.js
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. OUTBOX TABLE ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     VARCHAR(100) NOT NULL,
  aggregate_id   VARCHAR(255) NOT NULL,
  aggregate_type VARCHAR(100) NOT NULL,
  payload        JSONB        NOT NULL DEFAULT '{}',
  status         VARCHAR(20)  NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','processed','dead')),
  attempts       INTEGER      NOT NULL DEFAULT 0,
  max_attempts   INTEGER      NOT NULL DEFAULT 5,
  process_after  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (status, process_after)
  WHERE status = 'pending';

-- ─── 2. FOREIGN KEY HARDENING — orders ───────────────────────────────────────
-- Ensure orders.user_id references users.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_orders_user_id' AND table_name = 'orders'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_user_id
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 3. FOREIGN KEY HARDENING — escrow_transactions ──────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_escrow_order_id' AND table_name = 'escrow_transactions'
  ) THEN
    ALTER TABLE escrow_transactions
      ADD CONSTRAINT fk_escrow_order_id
      FOREIGN KEY (order_id) REFERENCES orders(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_escrow_user_id' AND table_name = 'escrow_transactions'
  ) THEN
    ALTER TABLE escrow_transactions
      ADD CONSTRAINT fk_escrow_user_id
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 4. FOREIGN KEY HARDENING — supplier_payments ────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_supplier_payments_order' AND table_name = 'supplier_payments'
  ) THEN
    ALTER TABLE supplier_payments
      ADD CONSTRAINT fk_supplier_payments_order
      FOREIGN KEY (order_id) REFERENCES orders(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 5. FOREIGN KEY HARDENING — tracking_records ─────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_tracking_order' AND table_name = 'tracking_records'
  ) THEN
    ALTER TABLE tracking_records
      ADD CONSTRAINT fk_tracking_order
      FOREIGN KEY (order_id) REFERENCES orders(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 6. FOREIGN KEY HARDENING — refund_records ───────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_refunds_order' AND table_name = 'refund_records'
  ) THEN
    ALTER TABLE refund_records
      ADD CONSTRAINT fk_refunds_order
      FOREIGN KEY (order_id) REFERENCES orders(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 7. FOREIGN KEY HARDENING — profit_distributions ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_profit_dist_order' AND table_name = 'profit_distributions'
  ) THEN
    ALTER TABLE profit_distributions
      ADD CONSTRAINT fk_profit_dist_order
      FOREIGN KEY (order_id) REFERENCES orders(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 8. CHECK CONSTRAINTS — financial integrity ───────────────────────────────
-- Orders: amount must be positive
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_total_positive;
ALTER TABLE orders
  ADD CONSTRAINT chk_orders_total_positive
  CHECK (total_price >= 0);

-- Escrow: amount must be positive
ALTER TABLE escrow_transactions
  DROP CONSTRAINT IF EXISTS chk_escrow_amount_positive;
ALTER TABLE escrow_transactions
  ADD CONSTRAINT chk_escrow_amount_positive
  CHECK (amount > 0);

-- Withdrawals: amount must be positive
ALTER TABLE withdrawals
  DROP CONSTRAINT IF EXISTS chk_withdrawal_amount_positive;
ALTER TABLE withdrawals
  ADD CONSTRAINT chk_withdrawal_amount_positive
  CHECK (amount > 0);

-- Wallet balances: balance must not go negative
ALTER TABLE wallet_balances
  DROP CONSTRAINT IF EXISTS chk_wallet_balance_non_negative;
ALTER TABLE wallet_balances
  ADD CONSTRAINT chk_wallet_balance_non_negative
  CHECK (balance >= 0);

-- ─── 9. UNIQUE CONSTRAINTS — idempotency ─────────────────────────────────────
-- Orders: unique platform order ID per user prevents duplicate ingestion
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_platform_unique
  ON orders (user_id, shopify_order_id)
  WHERE shopify_order_id IS NOT NULL;

-- Escrow: unique per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_order_unique
  ON escrow_transactions (order_id)
  WHERE status NOT IN ('refunded', 'cancelled');

-- ─── 10. AUDIT TRIGGER — financial tables ────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_audit_log (
  id           BIGSERIAL    PRIMARY KEY,
  table_name   VARCHAR(100) NOT NULL,
  operation    VARCHAR(10)  NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  record_id    TEXT         NOT NULL,
  old_data     JSONB,
  new_data     JSONB,
  changed_by   TEXT,
  changed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_audit_table
  ON financial_audit_log (table_name, changed_at DESC);

CREATE OR REPLACE FUNCTION fn_financial_audit()
RETURNS TRIGGER AS $$
DECLARE
  v_record_id TEXT;
BEGIN
  v_record_id := COALESCE(NEW.id::TEXT, OLD.id::TEXT);

  INSERT INTO financial_audit_log (table_name, operation, record_id, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    v_record_id,
    CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply audit trigger to all financial tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'escrow_transactions',
    'supplier_payments',
    'withdrawals',
    'wallet_balances',
    'wallet_transactions',
    'profit_distributions',
    'refund_records'
  ]
  LOOP
    EXECUTE format('
      DROP TRIGGER IF EXISTS trg_audit_%1$s ON %1$s;
      CREATE TRIGGER trg_audit_%1$s
        AFTER INSERT OR UPDATE OR DELETE ON %1$s
        FOR EACH ROW EXECUTE FUNCTION fn_financial_audit();
    ', tbl);
  END LOOP;
END $$;

-- ─── 11. WALLET VERSION COLUMN (for SELECT FOR UPDATE optimistic lock) ────────
ALTER TABLE wallet_balances
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- ─── 12. INDEXES for performance ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_user_status
  ON orders (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_escrow_status
  ON escrow_transactions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_status
  ON withdrawals (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_order
  ON supplier_payments (order_id);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user
  ON wallet_transactions (user_id, created_at DESC);

-- ─── 13. VERSION tracking ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(50) PRIMARY KEY,
  description TEXT,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, description)
VALUES ('v66-hardening', 'V66 Enterprise Certification: FK hardening, check constraints, audit triggers, outbox table')
ON CONFLICT (version) DO NOTHING;

COMMIT;
