-- Migration 015 — AI Provider Management Strict Contract
-- Adds explicit auth/default/quota fields and compatibility relations matching
-- the public enterprise contract names while keeping the certified v69 catalog
-- tables as the operational source of truth.

ALTER TABLE ai_provider_catalog
  ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'bearer'
    CHECK (auth_type IN ('bearer','x-api-key','query-param','none')),
  ADD COLUMN IF NOT EXISTS query_param_name TEXT,
  ADD COLUMN IF NOT EXISTS daily_request_limit BIGINT,
  ADD COLUMN IF NOT EXISTS monthly_request_limit BIGINT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_default_per_category
  ON ai_provider_catalog (category)
  WHERE is_default = true AND status = 'approved' AND is_enabled = true;

ALTER TABLE user_ai_provider_preferences
  ADD COLUMN IF NOT EXISTS provider_key TEXT;

-- Contract-name compatibility views. These expose the required relation names
-- without duplicating secrets or forking routing state.
CREATE OR REPLACE VIEW ai_providers AS
SELECT
  id,
  display_name AS name,
  provider_key AS slug,
  provider_type,
  COALESCE(api_base_url, base_url) AS api_base_url,
  encrypted_api_key AS api_key,
  auth_type,
  auth_header_name,
  default_model,
  supported_models,
  supports_streaming,
  supports_vision,
  supports_json_mode,
  supports_function_calling,
  generation_defaults->>'maxTokens' AS max_tokens,
  generation_defaults->>'temperature' AS temperature,
  generation_defaults->>'timeoutMs' AS timeout_ms,
  generation_defaults->>'retryCount' AS retry_count,
  rate_limits->>'requestsPerMinute' AS requests_per_minute,
  daily_request_limit,
  monthly_request_limit,
  daily_budget,
  monthly_budget,
  priority,
  fallback_priority,
  is_enabled AS enabled,
  is_default,
  health_status,
  created_at,
  updated_at
FROM ai_provider_catalog;

CREATE OR REPLACE VIEW user_ai_provider_keys AS
SELECT
  id,
  tenant_id,
  provider_id,
  provider_key,
  encrypted_api_key AS api_key,
  encrypted_secondary,
  connection_status,
  is_active,
  created_at,
  updated_at
FROM user_ai_provider_connections;

CREATE OR REPLACE VIEW ai_provider_usage_logs AS
SELECT * FROM user_ai_usage_events;

CREATE OR REPLACE VIEW ai_provider_health_logs AS
SELECT * FROM ai_provider_health_snapshots;
