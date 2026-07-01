-- Dynamic Website Platform Management
-- Database-driven ecommerce / marketplace / CMS / custom website integrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS website_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('ecommerce','marketplace','cms','erp','pos','custom_website')),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth2','api_key','bearer_token','jwt','username_password','webhook','custom','none')),
  api_base_url TEXT,
  oauth_url TEXT,
  token_url TEXT,
  redirect_url TEXT,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  webhook_secret_ciphertext TEXT,
  webhook_secret_iv TEXT,
  webhook_secret_auth_tag TEXT,
  api_version TEXT,
  health_endpoint TEXT,
  documentation_url TEXT,
  supported_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  connection_wizard JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT false,
  maintenance_mode BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 100,
  fallback_priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_website_platforms_enabled_priority
  ON website_platforms (enabled, maintenance_mode, priority, fallback_priority);

CREATE UNIQUE INDEX IF NOT EXISTS idx_website_platform_default_category
  ON website_platforms (category)
  WHERE is_default = true AND enabled = true AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_platform_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  platform_id UUID NOT NULL REFERENCES website_platforms(id) ON DELETE RESTRICT,
  account_label TEXT,
  encrypted_credentials TEXT NOT NULL,
  credentials_iv TEXT NOT NULL,
  credentials_auth_tag TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  connection_status TEXT NOT NULL DEFAULT 'active',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_validated_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_user_platform_connections_tenant
  ON user_platform_connections (tenant_id, is_active);

CREATE INDEX IF NOT EXISTS idx_user_platform_connections_platform
  ON user_platform_connections (platform_id, is_active);

CREATE TABLE IF NOT EXISTS platform_api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  platform_id UUID REFERENCES website_platforms(id) ON DELETE SET NULL,
  connection_id UUID REFERENCES user_platform_connections(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  endpoint TEXT,
  method TEXT,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_api_logs_platform_created
  ON platform_api_logs (platform_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id UUID NOT NULL REFERENCES website_platforms(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_health_platform_created
  ON platform_health (platform_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  platform_id UUID REFERENCES website_platforms(id) ON DELETE SET NULL,
  connection_id UUID REFERENCES user_platform_connections(id) ON DELETE SET NULL,
  products_synced INTEGER NOT NULL DEFAULT 0,
  orders_synced INTEGER NOT NULL DEFAULT 0,
  inventory_updates INTEGER NOT NULL DEFAULT 0,
  customers_synced INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  sync_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_usage_platform_created
  ON platform_usage (platform_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  platform_id UUID NOT NULL REFERENCES website_platforms(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES user_platform_connections(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  callback_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_webhooks_platform_event
  ON platform_webhooks (platform_id, event_type, status);
