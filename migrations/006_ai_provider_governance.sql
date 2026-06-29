-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006 — AI Provider Governance + User AI Connections + Business Accounts
-- Idempotent: safe to re-run (IF NOT EXISTS throughout)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Admin-Governed AI Provider Catalog ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_provider_catalog (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key        TEXT        NOT NULL UNIQUE,   -- e.g. 'openai', 'claude', 'runway'
  display_name        TEXT        NOT NULL,
  category            TEXT        NOT NULL
                      CHECK (category IN (
                        'reasoning','image_generation','video_generation',
                        'voice','embedding','multimodal'
                      )),
  description         TEXT,
  sdk_class           TEXT,       -- internal class name e.g. 'OpenAiUserProvider'
  base_url            TEXT,
  docs_url            TEXT,
  status              TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','disabled','deprecated')),
  requires_secondary_key BOOLEAN  NOT NULL DEFAULT false,
  secondary_key_label TEXT,       -- label for UI e.g. 'Organization ID'
  health_check_url    TEXT,
  health_check_method TEXT        DEFAULT 'GET',
  capabilities        JSONB       NOT NULL DEFAULT '{}',
                                  -- { supportsStreaming, supportsImages, maxTokens, ... }
  pricing_per_unit    NUMERIC(10,6),
  pricing_unit        TEXT,       -- 'per_1k_tokens', 'per_image', 'per_second'
  approved_by         UUID,       -- admin user id
  approved_at         TIMESTAMPTZ,
  disabled_reason     TEXT,
  sort_order          INT         NOT NULL DEFAULT 0,
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_catalog_status    ON ai_provider_catalog (status);
CREATE INDEX IF NOT EXISTS idx_ai_catalog_category  ON ai_provider_catalog (category);

-- ── 2. Provider Approval Audit Log ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_provider_approval_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID        NOT NULL REFERENCES ai_provider_catalog(id) ON DELETE CASCADE,
  admin_id     UUID        NOT NULL,
  action       TEXT        NOT NULL
               CHECK (action IN ('submitted','approved','disabled','deprecated','key_rotated','health_override')),
  old_status   TEXT,
  new_status   TEXT,
  reason       TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_approval_log_provider ON ai_provider_approval_log (provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_approval_log_admin    ON ai_provider_approval_log (admin_id);

-- ── 3. Provider Health Snapshots ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_provider_health_snapshots (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      UUID        NOT NULL REFERENCES ai_provider_catalog(id) ON DELETE CASCADE,
  status           TEXT        NOT NULL CHECK (status IN ('healthy','degraded','down','unknown')),
  latency_ms       INT,
  error_message    TEXT,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_health_provider_time
  ON ai_provider_health_snapshots (provider_id, checked_at DESC);

-- ── 4. User AI Provider Connections ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_ai_provider_connections (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL,
  provider_id           UUID        NOT NULL REFERENCES ai_provider_catalog(id) ON DELETE CASCADE,
  provider_key          TEXT        NOT NULL,   -- denorm from catalog for fast lookups
  encrypted_api_key     TEXT        NOT NULL,   -- AES-256-GCM encrypted
  encrypted_secondary   TEXT,                  -- e.g. org ID, encrypted
  key_iv                TEXT        NOT NULL,
  key_auth_tag          TEXT        NOT NULL,
  secondary_iv          TEXT,
  secondary_auth_tag    TEXT,
  key_version           INT         NOT NULL DEFAULT 1,
  connection_status     TEXT        NOT NULL DEFAULT 'pending_validation'
                        CHECK (connection_status IN (
                          'pending_validation','active','invalid_key',
                          'quota_exceeded','rate_limited','disabled'
                        )),
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  allow_platform_fallback BOOLEAN   NOT NULL DEFAULT false,  -- user opts in explicitly
  last_health_check     TIMESTAMPTZ,
  last_health_status    TEXT,
  last_health_error     TEXT,
  quota_limit           BIGINT,     -- NULL = unlimited (user-set cap)
  quota_used            BIGINT      NOT NULL DEFAULT 0,
  quota_reset_at        TIMESTAMPTZ,
  total_requests        BIGINT      NOT NULL DEFAULT 0,
  total_tokens          BIGINT      NOT NULL DEFAULT 0,
  total_cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  metadata              JSONB       NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, provider_id)   -- one connection per provider per tenant
);

CREATE INDEX IF NOT EXISTS idx_user_ai_conn_tenant   ON user_ai_provider_connections (tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_ai_conn_provider ON user_ai_provider_connections (provider_id);
CREATE INDEX IF NOT EXISTS idx_user_ai_conn_active   ON user_ai_provider_connections (tenant_id, is_active);

-- ── 5. User AI Usage Events (per-tenant observability) ───────────────────────
CREATE TABLE IF NOT EXISTS user_ai_usage_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  connection_id    UUID        NOT NULL REFERENCES user_ai_provider_connections(id) ON DELETE CASCADE,
  provider_key     TEXT        NOT NULL,
  operation        TEXT        NOT NULL,   -- 'script','image','video','voice','embed'
  model_used       TEXT,
  prompt_tokens    INT         DEFAULT 0,
  completion_tokens INT        DEFAULT 0,
  total_tokens     INT         DEFAULT 0,
  latency_ms       INT,
  cost_usd         NUMERIC(10,6),
  success          BOOLEAN     NOT NULL DEFAULT true,
  error_code       TEXT,
  error_message    TEXT,
  campaign_id      UUID,
  creative_id      UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_time ON user_ai_usage_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_connection  ON user_ai_usage_events (connection_id, created_at DESC);

-- ── 6. User Business Account Connections ────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_business_connections (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  platform           TEXT        NOT NULL
                     CHECK (platform IN (
                       'meta_ads','meta_instagram','meta_facebook_page',
                       'tiktok','youtube','shopify','whatsapp_business',
                       'telegram_notify'
                     )),
  account_label      TEXT,        -- user-friendly label e.g. "Main Store"
  -- All credential fields are AES-256-GCM encrypted
  encrypted_primary_token  TEXT,
  primary_iv               TEXT,
  primary_auth_tag         TEXT,
  encrypted_secondary_token TEXT,
  secondary_iv             TEXT,
  secondary_auth_tag       TEXT,
  encrypted_account_id     TEXT,  -- e.g. Meta Ad Account ID, Shopify shop domain
  account_id_iv            TEXT,
  account_id_auth_tag      TEXT,
  encrypted_pixel_id       TEXT,
  pixel_iv                 TEXT,
  pixel_auth_tag           TEXT,
  key_version              INT    NOT NULL DEFAULT 1,
  connection_status        TEXT   NOT NULL DEFAULT 'pending_validation'
                           CHECK (connection_status IN (
                             'pending_validation','active','token_expired',
                             'permission_denied','rate_limited','disabled'
                           )),
  is_active                BOOLEAN NOT NULL DEFAULT true,
  scopes_granted           JSONB   NOT NULL DEFAULT '[]',  -- OAuth scopes
  token_expires_at         TIMESTAMPTZ,
  last_validated_at        TIMESTAMPTZ,
  last_validation_error    TEXT,
  metadata                 JSONB   NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_biz_conn_tenant          ON user_business_connections (tenant_id);
CREATE INDEX IF NOT EXISTS idx_biz_conn_platform        ON user_business_connections (tenant_id, platform);
CREATE INDEX IF NOT EXISTS idx_biz_conn_active          ON user_business_connections (tenant_id, is_active);

-- ── 7. Provider Request Tickets ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_provider_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  provider_name   TEXT        NOT NULL,
  provider_url    TEXT,
  reason          TEXT        NOT NULL,
  use_case        TEXT,
  status          TEXT        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','under_review','approved','rejected','duplicate')),
  reviewed_by     UUID,
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  linked_provider_id UUID     REFERENCES ai_provider_catalog(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_requests_tenant ON ai_provider_requests (tenant_id);
CREATE INDEX IF NOT EXISTS idx_provider_requests_status ON ai_provider_requests (status);

-- ── 8. Video Pipeline Jobs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_pipeline_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  campaign_id       UUID,
  product_id        UUID,
  status            TEXT        NOT NULL DEFAULT 'queued'
                    CHECK (status IN (
                      'queued','scripting','generating_images','generating_clips',
                      'assembling','adding_subtitles','scoring','completed',
                      'failed','cancelled'
                    )),
  pipeline_config   JSONB       NOT NULL DEFAULT '{}',
  -- Which provider keys were used (provider_key only — never actual keys)
  reasoning_provider TEXT,
  image_provider    TEXT,
  video_provider    TEXT,
  voice_provider    TEXT,
  -- Outputs
  script_json       JSONB,
  scenes_json       JSONB,
  telegram_asset_id UUID,      -- final assembled video stored via TelegramStorage
  subtitle_asset_id UUID,
  thumbnail_asset_id UUID,
  virality_score    NUMERIC(5,2),
  predicted_ctr     NUMERIC(5,4),
  predicted_roas    NUMERIC(8,4),
  ab_variant        TEXT,       -- 'A' | 'B' | 'C'
  error_message     TEXT,
  retry_count       INT         NOT NULL DEFAULT 0,
  processing_ms     INT,
  metadata          JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_tenant  ON video_pipeline_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status  ON video_pipeline_jobs (status);
CREATE INDEX IF NOT EXISTS idx_video_jobs_campaign ON video_pipeline_jobs (campaign_id);

-- ── 9. Organic Publishing Jobs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organic_publish_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  platform          TEXT        NOT NULL
                    CHECK (platform IN ('instagram','facebook','tiktok','youtube_shorts')),
  connection_id     UUID        REFERENCES user_business_connections(id),
  video_job_id      UUID        REFERENCES video_pipeline_jobs(id),
  caption           TEXT,
  hashtags          TEXT[],
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  platform_post_id  TEXT,       -- ID returned by platform after publish
  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending','scheduled','publishing','published',
                      'failed','cancelled'
                    )),
  views             BIGINT      DEFAULT 0,
  likes             BIGINT      DEFAULT 0,
  comments          BIGINT      DEFAULT 0,
  shares            BIGINT      DEFAULT 0,
  saves             BIGINT      DEFAULT 0,
  reach             BIGINT      DEFAULT 0,
  organic_conversions BIGINT    DEFAULT 0,
  last_stats_sync   TIMESTAMPTZ,
  error_message     TEXT,
  metadata          JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organic_jobs_tenant   ON organic_publish_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_organic_jobs_status   ON organic_publish_jobs (status);
CREATE INDEX IF NOT EXISTS idx_organic_jobs_schedule ON organic_publish_jobs (scheduled_at) WHERE status = 'scheduled';

-- ── Seed: Pre-approved AI Providers ──────────────────────────────────────────
INSERT INTO ai_provider_catalog
  (provider_key, display_name, category, description, capabilities, pricing_unit, sort_order, status)
VALUES
  ('openai',     'OpenAI',          'reasoning',         'GPT-4o, GPT-4 Turbo — reasoning + text generation',
   '{"supportsStreaming":true,"maxTokens":128000,"models":["gpt-4o","gpt-4-turbo"]}',
   'per_1k_tokens', 10, 'approved'),

  ('claude',     'Anthropic Claude', 'reasoning',        'Claude 3.5 Sonnet/Haiku — reasoning + analysis',
   '{"supportsStreaming":true,"maxTokens":200000,"models":["claude-sonnet-4-5","claude-haiku-4-5"]}',
   'per_1k_tokens', 20, 'approved'),

  ('openrouter', 'OpenRouter',       'reasoning',        'Unified gateway to 100+ models',
   '{"supportsStreaming":true,"multiModel":true}',
   'per_1k_tokens', 30, 'approved'),

  ('flux',       'Flux (Black Forest Labs)', 'image_generation', 'FLUX.1 — highest quality image generation',
   '{"supportsHD":true,"maxResolution":"2048x2048","models":["flux-1-pro","flux-1-schnell"]}',
   'per_image', 40, 'approved'),

  ('runway',     'Runway ML',        'video_generation', 'Gen-3 Alpha Turbo — commercial video generation',
   '{"maxDurationSec":10,"models":["gen3a_turbo"],"supportsImageToVideo":true}',
   'per_second', 50, 'approved'),

  ('kling',      'Kling AI',         'video_generation', 'Kling 1.5 — cinematic video generation',
   '{"maxDurationSec":30,"models":["kling-v1-5"],"supportsImageToVideo":true}',
   'per_second', 60, 'approved'),

  ('elevenlabs', 'ElevenLabs',       'voice',            'Ultra-realistic AI voiceovers for ads',
   '{"supportsCloning":true,"languages":["en","hi","es","fr"]}',
   'per_1k_chars', 70, 'approved'),

  ('nvidia',     'NVIDIA NIM',       'reasoning',        'NVIDIA hosted LLMs — Llama 3 70B / 405B',
   '{"supportsStreaming":true,"models":["meta/llama-3.1-70b-instruct","meta/llama-3.1-405b-instruct"]}',
   'per_1k_tokens', 80, 'approved')

ON CONFLICT (provider_key) DO NOTHING;
