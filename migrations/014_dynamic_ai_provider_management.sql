-- Migration 014 — Dynamic AI Provider Management
-- Adds database-driven provider execution, platform-key rotation, BYOK flags,
-- provider preferences, and richer governance metadata without removing the
-- v69 provider catalog contract.

ALTER TABLE ai_provider_catalog
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS provider_type TEXT DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS api_base_url TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_api_key TEXT,
  ADD COLUMN IF NOT EXISTS api_key_iv TEXT,
  ADD COLUMN IF NOT EXISTS api_key_auth_tag TEXT,
  ADD COLUMN IF NOT EXISTS api_key_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS organization_id TEXT,
  ADD COLUMN IF NOT EXISTS supported_models JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS default_model TEXT,
  ADD COLUMN IF NOT EXISTS generation_defaults JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS pricing JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS quotas JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS rate_limits JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS circuit_breaker JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS fallback_priority INT NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS byok_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_streaming BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supports_vision BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supports_image_generation BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supports_function_calling BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supports_json_mode BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_format TEXT NOT NULL DEFAULT 'openai_compatible',
  ADD COLUMN IF NOT EXISTS endpoint_path TEXT NOT NULL DEFAULT '/chat/completions',
  ADD COLUMN IF NOT EXISTS auth_header_name TEXT NOT NULL DEFAULT 'Authorization',
  ADD COLUMN IF NOT EXISTS auth_header_template TEXT NOT NULL DEFAULT 'Bearer {{apiKey}}',
  ADD COLUMN IF NOT EXISTS request_template JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS response_mapping JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS daily_budget NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS monthly_budget NUMERIC(12,4);

UPDATE ai_provider_catalog
SET api_base_url = COALESCE(api_base_url, base_url),
    provider_type = COALESCE(provider_type, CASE
      WHEN category = 'image_generation' THEN 'image'
      WHEN category = 'video_generation' THEN 'video'
      WHEN category = 'voice' THEN 'audio'
      WHEN category = 'embedding' THEN 'embedding'
      WHEN category = 'multimodal' THEN 'vision'
      ELSE 'chat'
    END),
    supported_models = CASE
      WHEN jsonb_typeof(capabilities->'models') = 'array' THEN capabilities->'models'
      ELSE supported_models
    END,
    is_enabled = CASE WHEN status = 'approved' THEN true ELSE is_enabled END
WHERE TRUE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_provider_approval_log_action_check'
  ) THEN
    ALTER TABLE ai_provider_approval_log
      DROP CONSTRAINT ai_provider_approval_log_action_check;
  END IF;
END $$;

ALTER TABLE ai_provider_approval_log
  ADD CONSTRAINT ai_provider_approval_log_action_check
  CHECK (action IN (
    'submitted','approved','disabled','deprecated','key_rotated',
    'health_override','updated','deleted','connectivity_tested','imported','exported'
  ));

CREATE TABLE IF NOT EXISTS user_ai_provider_preferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  category      TEXT NOT NULL,
  provider_id   UUID REFERENCES ai_provider_catalog(id) ON DELETE SET NULL,
  model         TEXT,
  use_byok      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, category)
);

CREATE INDEX IF NOT EXISTS idx_ai_catalog_enabled_priority
  ON ai_provider_catalog (status, is_enabled, category, priority, fallback_priority);

CREATE INDEX IF NOT EXISTS idx_ai_catalog_health
  ON ai_provider_catalog (health_status, last_health_check_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_ai_preferences_tenant
  ON user_ai_provider_preferences (tenant_id, category);

-- Platform-managed provider usage does not always have a user BYOK
-- connection row. Keep the FK for BYOK events, but allow NULL for
-- platform-key routed events so every request can still be logged.
ALTER TABLE user_ai_usage_events
  ALTER COLUMN connection_id DROP NOT NULL;
