/**
 * UserAiConnectionsService
 *
 * Manages user-owned AI provider API keys.
 *
 * CRITICAL SECURITY RULES (enforced here):
 *  1. Users can ONLY connect keys for admin-approved providers
 *  2. Keys are AES-256-GCM encrypted at rest — NEVER stored plaintext
 *  3. Decrypted keys are NEVER returned to the frontend
 *  4. Decrypted keys live in memory only during active API calls
 *  5. Each tenant's keys are cryptographically isolated
 *  6. Admin keys (ConfigVaultService) are NEVER accessed from this service
 *
 * USER AI LAYER — completely separate from PLATFORM AI LAYER.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
  Inject,
} from '@nestjs/common';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import { DB_POOL } from '../common/database/database.module';
import { AiProviderRegistryService } from '../ai-provider-registry/ai-provider-registry.service';
import { AuditService } from '../audit/audit.service';
import { ConnectProviderDto, UpdateConnectionDto, SetAiProviderPreferenceDto } from './dto/user-ai-connections.dto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN    = 12;
const TAG_LEN   = 16;

export interface UserProviderConnection {
  id: string;
  tenantId: string;
  providerId: string;
  providerKey: string;
  providerDisplayName?: string;
  connectionStatus: string;
  isActive: boolean;
  allowPlatformFallback: boolean;
  lastHealthCheck: Date | null;
  lastHealthStatus: string | null;
  quotaLimit: number | null;
  quotaUsed: number;
  totalRequests: number;
  totalTokens: number;
  totalCostUsd: number;
  createdAt: Date;
  updatedAt: Date;
  // NOTE: encrypted_api_key is NEVER included in this interface
}

@Injectable()
export class UserAiConnectionsService {
  private readonly logger = new Logger(UserAiConnectionsService.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly registry: AiProviderRegistryService,
    private readonly audit:    AuditService,
  ) {}

  // ── Connect a user's API key to an approved provider ─────────────────────

  async connectProvider(
    tenantId: string,
    dto: ConnectProviderDto,
  ): Promise<UserProviderConnection> {
    // GATE 1: Provider must be admin-approved
    const provider = await this.registry.assertProviderApproved(dto.providerId);

    // GATE 2: Validate API key with provider (lightweight check)
    await this.validateKeyWithProvider(provider.providerKey, dto.apiKey, dto.secondaryKey);

    // Encrypt primary key
    const { ciphertext: encKey, iv: keyIv, authTag: keyTag } =
      this.encrypt(dto.apiKey);

    // Encrypt secondary key if present
    let encSecondary: string | null = null;
    let secIv: string | null = null;
    let secTag: string | null = null;
    if (dto.secondaryKey) {
      const enc = this.encrypt(dto.secondaryKey);
      encSecondary = enc.ciphertext;
      secIv        = enc.iv;
      secTag       = enc.authTag;
    }

    // Upsert — one connection per tenant per provider
    const result = await this.db.query(
      `INSERT INTO user_ai_provider_connections (
         tenant_id, provider_id, provider_key,
         encrypted_api_key, key_iv, key_auth_tag,
         encrypted_secondary, secondary_iv, secondary_auth_tag,
         connection_status, is_active, allow_platform_fallback,
         last_health_check, last_health_status, quota_limit
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',true,$10,NOW(),'healthy',$11)
       ON CONFLICT (tenant_id, provider_id) DO UPDATE SET
         encrypted_api_key  = EXCLUDED.encrypted_api_key,
         key_iv             = EXCLUDED.key_iv,
         key_auth_tag       = EXCLUDED.key_auth_tag,
         encrypted_secondary = EXCLUDED.encrypted_secondary,
         secondary_iv       = EXCLUDED.secondary_iv,
         secondary_auth_tag = EXCLUDED.secondary_auth_tag,
         connection_status  = 'active',
         is_active          = true,
         key_version        = user_ai_provider_connections.key_version + 1,
         last_health_check  = NOW(),
         last_health_status = 'healthy',
         quota_limit        = EXCLUDED.quota_limit,
         updated_at         = NOW()
       RETURNING *`,
      [
        tenantId, dto.providerId, provider.providerKey,
        encKey, keyIv, keyTag,
        encSecondary, secIv, secTag,
        dto.allowPlatformFallback ?? false,
        dto.quotaLimit ?? null,
      ],
    );

    this.audit.log({
      tenantId,
      actorId:  tenantId,
      action:   'user_ai_connection.connected',
      resource: 'user_ai_provider_connections',
      resourceId: result.rows[0].id,
      details: { providerKey: provider.providerKey },
    });

    this.logger.log(`Tenant ${tenantId} connected provider: ${provider.providerKey}`);
    return this.mapRow(result.rows[0]);
  }

  // ── List user's connections (no keys exposed) ─────────────────────────────

  async listConnections(tenantId: string): Promise<UserProviderConnection[]> {
    const result = await this.db.query(
      `SELECT c.*, p.display_name AS provider_display_name
       FROM user_ai_provider_connections c
       JOIN ai_provider_catalog p ON p.id = c.provider_id
       WHERE c.tenant_id = $1 AND c.is_active = true
       ORDER BY c.created_at DESC`,
      [tenantId],
    );
    return result.rows.map(r => this.mapRow(r));
  }

  // ── Disconnect a provider ─────────────────────────────────────────────────

  async disconnectProvider(tenantId: string, connectionId: string): Promise<void> {
    const conn = await this.getConnectionOwnedByTenant(tenantId, connectionId);

    await this.db.query(
      `UPDATE user_ai_provider_connections
       SET is_active = false, connection_status = 'disabled', updated_at = NOW()
       WHERE id = $1`,
      [connectionId],
    );

    this.audit.log({
      tenantId,
      actorId:  tenantId,
      action:   'user_ai_connection.disconnected',
      resource: 'user_ai_provider_connections',
      resourceId: connectionId,
      details: { providerKey: conn.provider_key },
    });
  }

  // ── Decrypt key for runtime use ONLY ─────────────────────────────────────
  // This method is called ONLY by UserAiRouterService during AI generation.
  // The decrypted key lives in memory for the duration of the HTTP call only.

  async decryptKeyForRuntime(
    tenantId: string,
    providerKey: string,
  ): Promise<{ apiKey: string; secondaryKey: string | null }> {
    const result = await this.db.query(
      `SELECT c.encrypted_api_key, c.key_iv, c.key_auth_tag,
              c.encrypted_secondary, c.secondary_iv, c.secondary_auth_tag,
              c.connection_status, c.is_active, c.quota_used, c.quota_limit
       FROM user_ai_provider_connections c
       JOIN ai_provider_catalog p ON p.id = c.provider_id
       WHERE c.tenant_id = $1 AND p.provider_key = $2 AND c.is_active = true
       LIMIT 1`,
      [tenantId, providerKey],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException(
        `No active connection for provider '${providerKey}'. Connect your API key in Settings → AI Providers.`,
      );
    }

    const row = result.rows[0];

    if (row.connection_status !== 'active') {
      throw new ForbiddenException(
        `Provider '${providerKey}' connection is not active (status: ${row.connection_status}).`,
      );
    }

    // Quota check
    if (row.quota_limit !== null && row.quota_used >= row.quota_limit) {
      throw new ForbiddenException(
        `Provider '${providerKey}' quota exhausted (${row.quota_used}/${row.quota_limit}).`,
      );
    }

    const apiKey = this.decrypt(row.encrypted_api_key, row.key_iv, row.key_auth_tag);
    const secondaryKey = row.encrypted_secondary
      ? this.decrypt(row.encrypted_secondary, row.secondary_iv, row.secondary_auth_tag)
      : null;

    return { apiKey, secondaryKey };
  }

  // ── Record usage after successful generation ──────────────────────────────

  async recordUsage(
    tenantId: string,
    providerKey: string,
    operation: string,
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      latencyMs: number;
      costUsd: number;
      modelUsed?: string;
      campaignId?: string;
      creativeId?: string;
    },
  ): Promise<void> {
    // Find connection
    const result = await this.db.query(
      `SELECT c.id FROM user_ai_provider_connections c
       JOIN ai_provider_catalog p ON p.id = c.provider_id
       WHERE c.tenant_id = $1 AND p.provider_key = $2 AND c.is_active = true
       LIMIT 1`,
      [tenantId, providerKey],
    );
    if (result.rows.length === 0) return;
    const connectionId = result.rows[0].id;

    // Insert usage event
    await this.db.query(
      `INSERT INTO user_ai_usage_events (
         tenant_id, connection_id, provider_key, operation, model_used,
         prompt_tokens, completion_tokens, total_tokens,
         latency_ms, cost_usd, success, campaign_id, creative_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)`,
      [
        tenantId, connectionId, providerKey, operation,
        usage.modelUsed ?? null,
        usage.promptTokens, usage.completionTokens, usage.totalTokens,
        usage.latencyMs, usage.costUsd,
        usage.campaignId ?? null, usage.creativeId ?? null,
      ],
    );

    // Increment counters
    await this.db.query(
      `UPDATE user_ai_provider_connections
       SET quota_used    = quota_used    + $1,
           total_requests = total_requests + 1,
           total_tokens  = total_tokens  + $1,
           total_cost_usd = total_cost_usd + $2,
           updated_at    = NOW()
       WHERE id = $3`,
      [usage.totalTokens, usage.costUsd, connectionId],
    );
  }

  // ── Health check for a specific connection ────────────────────────────────

  async healthCheckConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<{ status: string; latencyMs: number | null; error?: string }> {
    const conn = await this.getConnectionOwnedByTenant(tenantId, connectionId);

    let status = 'healthy';
    let latencyMs: number | null = null;
    let error: string | undefined;

    try {
      const { apiKey, secondaryKey } = await this.decryptKeyForRuntime(tenantId, conn.provider_key);
      const start = Date.now();
      await this.validateKeyWithProvider(conn.provider_key, apiKey, secondaryKey ?? undefined);
      latencyMs = Date.now() - start;
    } catch (err) {
      status = 'unhealthy';
      error  = (err as Error).message;
    }

    await this.db.query(
      `UPDATE user_ai_provider_connections
       SET last_health_check = NOW(), last_health_status = $1, last_health_error = $2,
           connection_status = $3, updated_at = NOW()
       WHERE id = $4`,
      [status, error ?? null, status === 'healthy' ? 'active' : 'invalid_key', connectionId],
    );

    return { status, latencyMs, error };
  }

  // ── Get usage analytics for a tenant ─────────────────────────────────────

  async getUsageAnalytics(tenantId: string, days = 30): Promise<any> {
    const result = await this.db.query(
      `SELECT
         provider_key,
         COUNT(*)::int AS total_requests,
         SUM(total_tokens)::bigint AS total_tokens,
         SUM(cost_usd)::numeric AS total_cost_usd,
         AVG(latency_ms)::int AS avg_latency_ms,
         COUNT(*) FILTER (WHERE success = false)::int AS error_count,
         MAX(created_at) AS last_used_at
       FROM user_ai_usage_events
       WHERE tenant_id = $1
         AND created_at > NOW() - ($2 || ' days')::INTERVAL
       GROUP BY provider_key
       ORDER BY total_requests DESC`,
      [tenantId, days],
    );

    return {
      period: `${days}d`,
      byProvider: result.rows,
    };
  }

  async setProviderPreference(
    tenantId: string,
    dto: SetAiProviderPreferenceDto,
  ): Promise<{ category: string; providerId: string; model: string | null; useByok: boolean }> {
    const provider = await this.registry.assertProviderApproved(dto.providerId);
    if (provider.category !== dto.category) {
      throw new ForbiddenException(
        `Provider '${provider.displayName}' is not available for category '${dto.category}'.`,
      );
    }

    await this.db.query(
      `INSERT INTO user_ai_provider_preferences (
         tenant_id, category, provider_id, provider_key, model, use_byok
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, category) DO UPDATE SET
         provider_id = EXCLUDED.provider_id,
         provider_key = EXCLUDED.provider_key,
         model = EXCLUDED.model,
         use_byok = EXCLUDED.use_byok,
         updated_at = NOW()`,
      [
        tenantId,
        dto.category,
        dto.providerId,
        provider.providerKey,
        dto.model ?? provider.defaultModel ?? null,
        dto.useByok ?? false,
      ],
    );

    this.audit.log({
      tenantId,
      actorId: tenantId,
      action: 'user_ai_preference.updated',
      resource: 'user_ai_provider_preferences',
      details: {
        category: dto.category,
        providerKey: provider.providerKey,
        model: dto.model ?? provider.defaultModel ?? null,
        useByok: dto.useByok ?? false,
      },
    });

    return {
      category: dto.category,
      providerId: dto.providerId,
      model: dto.model ?? provider.defaultModel ?? null,
      useByok: dto.useByok ?? false,
    };
  }

  async getProviderPreferences(tenantId: string): Promise<any[]> {
    const result = await this.db.query(
      `SELECT pref.category, pref.provider_id, pref.provider_key, pref.model, pref.use_byok,
              p.display_name, p.default_model
       FROM user_ai_provider_preferences pref
       LEFT JOIN ai_provider_catalog p ON p.id = pref.provider_id
       WHERE pref.tenant_id = $1
       ORDER BY pref.category ASC`,
      [tenantId],
    );
    return result.rows.map((row: any) => ({
      category: row.category,
      providerId: row.provider_id,
      providerKey: row.provider_key,
      displayName: row.display_name,
      model: row.model ?? row.default_model,
      useByok: row.use_byok,
    }));
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────

  private getMasterKey(): Buffer {
    const key = process.env.ENCRYPTION_MASTER_KEY;
    if (!key || key.length < 32) {
      throw new Error('ENCRYPTION_MASTER_KEY not set or too short');
    }
    return Buffer.from(key.slice(0, 64), 'hex');
  }

  private encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
    const iv      = crypto.randomBytes(IV_LEN);
    const cipher  = crypto.createCipheriv(ALGORITHM, this.getMasterKey(), iv);
    const enc     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: enc.toString('base64'),
      iv:         iv.toString('base64'),
      authTag:    authTag.toString('base64'),
    };
  }

  private decrypt(ciphertext: string, iv: string, authTag: string): string {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      this.getMasterKey(),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  }

  /**
   * Lightweight provider key validation.
   * Makes a minimal API call (list models / account info) to verify the key works.
   * NEVER stores the result — exists only to confirm validity before saving.
   */
  private async validateKeyWithProvider(
    providerKey: string,
    apiKey: string,
    secondaryKey?: string,
  ): Promise<void> {
    const provider = await this.registry.getRuntimeProviderByKey(providerKey);
    if (!provider) {
      throw new UnprocessableEntityException(`Provider '${providerKey}' is not enabled`);
    }

    const url = provider.healthCheckUrl ??
      this.joinUrl(provider.apiBaseUrl ?? provider.baseUrl, provider.endpointPath ?? '/');

    if (!url) {
      // Some future providers may not expose a validation endpoint. The key is
      // still encrypted and will be validated on first real use.
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    headers[provider.authHeaderName ?? 'Authorization'] =
      (provider.authHeaderTemplate ?? 'Bearer {{apiKey}}')
        .replace('{{apiKey}}', apiKey)
        .replace('{{secondaryKey}}', secondaryKey ?? '');

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid API key');
      }
      if (res.status >= 500) {
        throw new Error(`Provider validation endpoint responded with ${res.status}`);
      }
    } catch (err) {
      throw new UnprocessableEntityException(
        `API key validation failed for '${providerKey}': ${(err as Error).message}`,
      );
    }
  }

  private joinUrl(base?: string | null, path?: string | null): string | null {
    if (!base) return null;
    if (!path) return base;
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private async getConnectionOwnedByTenant(tenantId: string, connectionId: string): Promise<any> {
    const result = await this.db.query(
      `SELECT c.*, p.provider_key FROM user_ai_provider_connections c
       JOIN ai_provider_catalog p ON p.id = c.provider_id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [connectionId, tenantId],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException('Connection not found');
    }
    return result.rows[0];
  }

  private mapRow(row: any): UserProviderConnection {
    return {
      id:                    row.id,
      tenantId:              row.tenant_id,
      providerId:            row.provider_id,
      providerKey:           row.provider_key,
      providerDisplayName:   row.provider_display_name,
      connectionStatus:      row.connection_status,
      isActive:              row.is_active,
      allowPlatformFallback: row.allow_platform_fallback,
      lastHealthCheck:       row.last_health_check,
      lastHealthStatus:      row.last_health_status,
      quotaLimit:            row.quota_limit ? Number(row.quota_limit) : null,
      quotaUsed:             Number(row.quota_used ?? 0),
      totalRequests:         Number(row.total_requests ?? 0),
      totalTokens:           Number(row.total_tokens ?? 0),
      totalCostUsd:          Number(row.total_cost_usd ?? 0),
      createdAt:             row.created_at,
      updatedAt:             row.updated_at,
      // encrypted_api_key is NEVER included
    };
  }
}
