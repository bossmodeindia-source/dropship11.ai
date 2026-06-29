-- ============================================================================
-- Migration 013: V65 Performance Indexes + Outbox Table + Constraints
-- ============================================================================
--
-- What this migration adds:
--
-- 1. CRITICAL UNIQUE CONSTRAINT: escrow_transactions(razorpay_payment_id)
--    Prevents duplicate escrow on Razorpay webhook retry (P0 financial bug fix)
--
-- 2. PERFORMANCE INDEXES (fixes N+1 and full-table scans):
--    - escrow_transactions(tenant_id, status)     — dashboard query
--    - escrow_transactions(tenant_id, order_id)   — order detail query
--    - audit_logs(tenant_id, created_at DESC)     — audit query (high volume)
--    - user_ai_connections(tenant_id, provider_key) — every AI request
--    - outbox_events(status, created_at)          — outbox flush query
--    - supplier_fulfillment_tasks(escrow_id)      — reconciliation query
--    - commission_config(is_active) partial       — single active config
--
-- 3. OUTBOX TABLE: outbox_events
--    Required for the transactional outbox pattern (OutboxService)
--
-- 4. PARTIAL INDEX for commission uniqueness
--    Prevents two active commission configs from coexisting
--
-- Run with: node src/database/migrations/run-v65-migrations.js
-- Idempotent: uses IF NOT EXISTS / CREATE INDEX CONCURRENTLY
-- ============================================================================

BEGIN;

-- ── 1. CRITICAL: Unique constraint on razorpay_payment_id ─────────────────────
--
-- Without this, a Razorpay webhook retry creates duplicate escrow records.
-- This is a P0 financial correctness fix.
--
-- NOTE: If duplicate data already exists (created before this migration),
-- you must deduplicate first:
--   DELETE FROM escrow_transactions a USING escrow_transactions b
--   WHERE a.id < b.id AND a.razorpay_payment_id = b.razorpay_payment_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_escrow_razorpay_payment_id'
  ) THEN
    ALTER TABLE escrow_transactions
      ADD CONSTRAINT uq_escrow_razorpay_payment_id
      UNIQUE (razorpay_payment_id);
  END IF;
END $$;

-- ── 2. Outbox events table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outbox_events (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL,
  payload     JSONB       NOT NULL DEFAULT '{}',
  status      TEXT        NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  attempts    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ,
  error       TEXT
);

COMMENT ON TABLE outbox_events IS
  'Transactional outbox — events written atomically with domain writes, '
  'delivered to queues by background worker. Guarantees at-least-once delivery.';

-- ── 3. Performance indexes ────────────────────────────────────────────────────

-- escrow_transactions: primary dashboard + order detail queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escrow_tenant_status
  ON escrow_transactions (tenant_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escrow_tenant_order
  ON escrow_transactions (tenant_id, order_id);

-- escrow_transactions: reconciliation query (AWAITING + old records)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escrow_status_updated
  ON escrow_transactions (status, updated_at)
  WHERE status IN ('AWAITING_SUPPLIER_PAYMENT', 'ESCROW_CREATED', 'DELIVERED');

-- audit_logs: high-volume table, filtered by tenant + time
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_tenant_created
  ON audit_logs (tenant_id, created_at DESC);

-- audit_logs: resource lookup (escrow, order audit trails)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_resource
  ON audit_logs (resource_id, created_at DESC);

-- user_ai_connections: fetched on EVERY AI generation request
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_ai_conn_tenant_provider
  ON user_ai_connections (tenant_id, provider_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_ai_conn_tenant_active
  ON user_ai_connections (tenant_id)
  WHERE is_active = true;

-- outbox_events: flush query (poll PENDING + stuck PROCESSING)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_status_created
  ON outbox_events (status, created_at ASC)
  WHERE status IN ('PENDING', 'PROCESSING');

-- outbox_events: failed event replay by tenant
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_failed_tenant
  ON outbox_events (tenant_id, created_at DESC)
  WHERE status = 'FAILED';

-- outbox_events: lookup by payload field for reconciliation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_event_type
  ON outbox_events (event_type, status);

-- supplier_fulfillment_tasks: reconciliation check (missing tasks)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supplier_task_escrow
  ON supplier_fulfillment_tasks (escrow_id);

-- supplier_routing: EMA score lookup (N+1 fix)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supplier_routing_reliability
  ON supplier_routing_profiles (supplier_id, reliability_score DESC);

-- ── 4. Commission config: prevent duplicate active configs ────────────────────

-- Partial unique index: only one row may have is_enabled = true
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_commission_config_active
  ON commission_config (is_enabled)
  WHERE is_enabled = true;

COMMENT ON INDEX uq_commission_config_active IS
  'Ensures only one commission configuration can be active at a time. '
  'Prevents race condition in CommissionService.upsertConfig().';

-- ── 5. Missing index on escrow_transactions(razorpay_order_id) ───────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escrow_razorpay_order
  ON escrow_transactions (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- ── 6. Wallet: lookup by tenant for profit crediting ─────────────────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tenant
  ON user_wallets (tenant_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_tenant_created
  ON wallet_transactions (tenant_id, created_at DESC);

-- ── 7. Provider health: circuit breaker status lookups ───────────────────────

-- These are in Redis, not DB, so no migration needed.
-- But AI provider registry table needs index:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_provider_registry_active
  ON ai_provider_registry (is_active, provider_key)
  WHERE is_active = true;

COMMIT;

-- ── Post-migration validation ────────────────────────────────────────────────
-- Run this to verify the critical unique constraint is active:
--
-- SELECT conname, contype FROM pg_constraint
-- WHERE conrelid = 'escrow_transactions'::regclass
--   AND conname = 'uq_escrow_razorpay_payment_id';
--
-- Expected: 1 row with contype = 'u'
