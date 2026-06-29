-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005 — Telegram Storage + Bot Pool Infrastructure
-- Idempotent: safe to re-run (IF NOT EXISTS guards throughout)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Telegram Storage Bot Pool ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_storage_bots (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_name            TEXT        NOT NULL,
  bot_username        TEXT        NOT NULL,
  bot_token_encrypted TEXT        NOT NULL,       -- AES-256-GCM encrypted
  status              TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','overloaded','flood_wait','disabled','banned')),
  current_load        INTEGER     NOT NULL DEFAULT 0,
  max_capacity        INTEGER     NOT NULL DEFAULT 100,
  flood_wait_until    TIMESTAMPTZ,
  total_uploads       BIGINT      NOT NULL DEFAULT 0,
  total_bytes         BIGINT      NOT NULL DEFAULT 0,
  last_health_check   TIMESTAMPTZ,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  assigned_channels   JSONB       NOT NULL DEFAULT '[]',  -- [{channelId, channelType}]
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tg_bots_status    ON telegram_storage_bots (status);
CREATE INDEX IF NOT EXISTS idx_tg_bots_active    ON telegram_storage_bots (is_active);
CREATE INDEX IF NOT EXISTS idx_tg_bots_load      ON telegram_storage_bots (current_load);

-- ── Telegram Storage Channels ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_storage_channels (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_name        TEXT        NOT NULL,
  channel_id_encrypted TEXT       NOT NULL,       -- AES-256-GCM encrypted channel ID
  channel_type        TEXT        NOT NULL DEFAULT 'general'
                      CHECK (channel_type IN (
                        'video','image','reel','zip','backup',
                        'creative','pdf','report','strategy','export','general'
                      )),
  status              TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','full','disabled')),
  asset_count         BIGINT      NOT NULL DEFAULT 0,
  max_assets          BIGINT      NOT NULL DEFAULT 5000000,  -- Telegram ~5M messages limit
  total_bytes         BIGINT      NOT NULL DEFAULT 0,
  assigned_bot_ids    JSONB       NOT NULL DEFAULT '[]',
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tg_channels_type   ON telegram_storage_channels (channel_type);
CREATE INDEX IF NOT EXISTS idx_tg_channels_status ON telegram_storage_channels (status);

-- ── Asset Metadata ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_assets (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  user_id             UUID        NOT NULL,
  project_id          UUID,
  campaign_id         UUID,

  -- Asset identity
  asset_type          TEXT        NOT NULL
                      CHECK (asset_type IN (
                        'video','image','reel','zip','backup',
                        'creative','pdf','report','strategy','export','website-build','other'
                      )),
  file_name           TEXT        NOT NULL,
  mime_type           TEXT        NOT NULL DEFAULT 'application/octet-stream',
  file_size           BIGINT      NOT NULL DEFAULT 0,
  checksum            TEXT        NOT NULL,           -- SHA-256 hex for deduplication

  -- Telegram references (encrypted at rest)
  telegram_file_id    TEXT,                           -- reusable Telegram file_id
  telegram_message_id TEXT,
  telegram_channel_id TEXT,                           -- AES-256-GCM encrypted

  -- Bot reference
  storage_bot_id      UUID        REFERENCES telegram_storage_bots(id) ON DELETE SET NULL,
  channel_record_id   UUID        REFERENCES telegram_storage_channels(id) ON DELETE SET NULL,

  -- Status lifecycle
  storage_status      TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (storage_status IN (
                        'pending','uploading','stored','failed','archived','deleted'
                      )),

  -- Archival (R2/S3)
  is_archived         BOOLEAN     NOT NULL DEFAULT false,
  archive_key         TEXT,                           -- R2/S3 object key
  archive_bucket      TEXT,
  archived_at         TIMESTAMPTZ,

  -- Tags & metadata
  tags                JSONB       NOT NULL DEFAULT '{}',
  metadata            JSONB       NOT NULL DEFAULT '{}',

  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ                     -- NULL = permanent
);

CREATE INDEX IF NOT EXISTS idx_tg_assets_tenant      ON telegram_assets (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tg_assets_user        ON telegram_assets (user_id);
CREATE INDEX IF NOT EXISTS idx_tg_assets_checksum    ON telegram_assets (checksum);
CREATE INDEX IF NOT EXISTS idx_tg_assets_bot         ON telegram_assets (storage_bot_id);
CREATE INDEX IF NOT EXISTS idx_tg_assets_type        ON telegram_assets (asset_type);
CREATE INDEX IF NOT EXISTS idx_tg_assets_status      ON telegram_assets (storage_status);
CREATE INDEX IF NOT EXISTS idx_tg_assets_created     ON telegram_assets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_assets_project     ON telegram_assets (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tg_assets_campaign    ON telegram_assets (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tg_assets_expires     ON telegram_assets (expires_at) WHERE expires_at IS NOT NULL;

-- ── MTProto Session Store (master provisioning credentials) ───────────────────
CREATE TABLE IF NOT EXISTS telegram_mtproto_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_name        TEXT        NOT NULL UNIQUE,
  api_id_encrypted    TEXT        NOT NULL,           -- AES-256-GCM
  api_hash_encrypted  TEXT        NOT NULL,           -- AES-256-GCM
  session_string_encrypted TEXT   NOT NULL,           -- AES-256-GCM
  phone_number        TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','expired','revoked')),
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Assertion: verify all tables created ─────────────────────────────────────
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name IN (
            'telegram_storage_bots','telegram_storage_channels',
            'telegram_assets','telegram_mtproto_sessions'
          )) = 4,
    'Migration 005: expected 4 tables to exist after migration';
END $$;

COMMENT ON TABLE telegram_storage_bots     IS 'Telegram Bot Pool — one bot per ~100 active workloads';
COMMENT ON TABLE telegram_storage_channels IS 'Private Telegram channels used as storage buckets';
COMMENT ON TABLE telegram_assets           IS 'Asset metadata index — Telegram is hot storage, R2/S3 is archival';
COMMENT ON TABLE telegram_mtproto_sessions IS 'MTProto master session for bot auto-provisioning via BotFather';
