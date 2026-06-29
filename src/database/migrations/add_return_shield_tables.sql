-- ============================================================
-- V64 Return Shield Migration
-- Controlled Return Holding System — Admin-Governed
-- ============================================================
-- CRITICAL: These tables implement a HOLDING PIPELINE.
-- NO automatic financial action is ever triggered.
-- ALL status transitions require admin intervention.
-- ============================================================

-- Enums
DO $$ BEGIN
  CREATE TYPE return_status AS ENUM (
    'RETURN_REQUESTED',
    'RETURN_PROCESSING',
    'UNDER_ADMIN_REVIEW',
    'WAITING_INTERNAL_APPROVAL',
    'REJECTED',
    'APPROVED_MANUALLY',
    'REFUND_MANUALLY_PROCESSED',
    'CLOSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE return_risk_level AS ENUM (
    'LOW', 'MEDIUM', 'HIGH_RISK_RETURN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE return_admin_action AS ENUM (
    'STATUS_CHANGED',
    'APPROVED',
    'REJECTED',
    'MORE_INFO_REQUESTED',
    'FROZEN',
    'CLOSED',
    'REFUND_TRIGGERED',
    'NOTE_ADDED',
    'RISK_FLAGGED',
    'AUDIT_EXPORTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── return_requests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS return_requests (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  VARCHAR(36)      NOT NULL,
  order_id                   UUID             NOT NULL,
  customer_id                UUID             NOT NULL REFERENCES users(id),
  product_id                 VARCHAR(100),
  reason                     TEXT             NOT NULL,
  notes                      TEXT,
  shopify_return_id          VARCHAR(100),

  -- DEFAULT: RETURN_PROCESSING — never auto-advances
  status                     return_status    NOT NULL DEFAULT 'RETURN_PROCESSING',

  admin_notes                TEXT,
  admin_actor_id             UUID REFERENCES users(id),
  rejection_reason           TEXT,

  -- Financial exposure (read-only reference for admin — never auto-acted)
  estimated_refund_exposure  NUMERIC(14,2),
  currency                   VARCHAR(3)       NOT NULL DEFAULT 'INR',

  -- Fraud scoring
  risk_level                 return_risk_level NOT NULL DEFAULT 'LOW',
  risk_score                 INTEGER           NOT NULL DEFAULT 0,
  risk_flags                 JSONB             NOT NULL DEFAULT '[]',

  -- Order context snapshot (admin reference only)
  fulfillment_status         VARCHAR(50),
  payment_status             VARCHAR(50),
  supplier_status            VARCHAR(50),
  user_profit_snapshot       NUMERIC(14,2),

  -- CRITICAL SAFETY FLAGS: Shopify automation is BLOCKED
  shopify_return_blocked     BOOLEAN NOT NULL DEFAULT TRUE,
  shopify_refund_blocked     BOOLEAN NOT NULL DEFAULT TRUE,

  admin_reviewed_at          TIMESTAMPTZ,
  refund_processed_at        TIMESTAMPTZ,
  closed_at                  TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_requests_tenant    ON return_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_return_requests_order     ON return_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_return_requests_customer  ON return_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_return_requests_status    ON return_requests(status);
CREATE INDEX IF NOT EXISTS idx_return_requests_risk      ON return_requests(risk_level);
CREATE INDEX IF NOT EXISTS idx_return_requests_created   ON return_requests(created_at DESC);

-- ── return_evidence ─────────────────────────────────────────────────────────
-- Metadata only. Actual files live in Telegram CDN (internal).
-- Telegram file IDs are stored encrypted. NEVER exposed to customers.
CREATE TABLE IF NOT EXISTS return_evidence (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id  UUID NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  tenant_id          VARCHAR(36)  NOT NULL,
  uploaded_by        UUID NOT NULL REFERENCES users(id),
  file_name          VARCHAR(255) NOT NULL,
  mime_type          VARCHAR(100) NOT NULL,
  file_size          INTEGER      NOT NULL,
  file_type          VARCHAR(20)  NOT NULL,   -- 'image' | 'video' | 'document'
  telegram_file_id   TEXT,                    -- encrypted, admin-only
  telegram_msg_id    VARCHAR(50),
  telegram_channel   VARCHAR(50),
  internal_url       TEXT,
  is_admin_only      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_evidence_request ON return_evidence(return_request_id);

-- ── return_status_history ───────────────────────────────────────────────────
-- Append-only. Every status transition recorded immutably.
CREATE TABLE IF NOT EXISTS return_status_history (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id  UUID NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  tenant_id          VARCHAR(36)  NOT NULL,
  from_status        VARCHAR(50),
  to_status          VARCHAR(50)  NOT NULL,
  actor_id           UUID REFERENCES users(id),
  actor_type         VARCHAR(20)  NOT NULL DEFAULT 'system',
  reason             TEXT,
  metadata           JSONB        NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_status_history_request ON return_status_history(return_request_id);
CREATE INDEX IF NOT EXISTS idx_return_status_history_created ON return_status_history(created_at DESC);

-- ── return_audit_logs ───────────────────────────────────────────────────────
-- Immutable enterprise audit trail.
-- Records every admin action + what automated action was PREVENTED.
CREATE TABLE IF NOT EXISTS return_audit_logs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id          UUID REFERENCES return_requests(id) ON DELETE SET NULL,
  tenant_id                  VARCHAR(36)   NOT NULL,
  actor_id                   UUID REFERENCES users(id),
  actor_role                 VARCHAR(30),
  action                     return_admin_action NOT NULL,
  description                TEXT          NOT NULL,
  previous_value             JSONB,
  new_value                  JSONB,
  -- Financial protection audit: what was explicitly NOT done
  auto_refund_prevented      BOOLEAN NOT NULL DEFAULT FALSE,
  auto_supplier_prevented    BOOLEAN NOT NULL DEFAULT FALSE,
  auto_inventory_prevented   BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address                 VARCHAR(45),
  user_agent                 TEXT,
  created_at                 TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_audit_request ON return_audit_logs(return_request_id);
CREATE INDEX IF NOT EXISTS idx_return_audit_actor   ON return_audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_return_audit_action  ON return_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_return_audit_created ON return_audit_logs(created_at DESC);

-- ── Updated_at trigger ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_return_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_return_requests_updated_at ON return_requests;
CREATE TRIGGER trg_return_requests_updated_at
  BEFORE UPDATE ON return_requests
  FOR EACH ROW EXECUTE FUNCTION update_return_requests_updated_at();
