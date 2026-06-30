/**
 * AiProviderRegistryService
 *
 * ADMIN-ONLY service for managing the global AI provider catalog.
 *
 * Security model:
 *  - ONLY admins can add / approve / disable / deprecate providers
 *  - Provider approval is audited in ai_provider_approval_log
 *  - Users CANNOT create providers or modify catalog entries
 *  - Users can only READ approved providers to connect their own keys
 *
 * This is the SOLE authority for which AI providers exist in the platform.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import { DB_POOL } from '../common/database/database.module';
import { AuditService } from '../audit/audit.service';
import {
  CreateProviderDto,
  UpdateProviderDto,
  ApproveProviderDto,
  ImportProvidersDto,
} from './dto/provider-registry.dto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;

export interface AiProviderCatalogEntry {
  id: string;
  providerKey: string;
  displayName: string;
  category: string;
  description: string | null;
  sdkClass: string | null;
  baseUrl: string | null;
  docsUrl: string | null;
  status: 'pending' | 'approved' | 'disabled' | 'deprecated';
  requiresSecondaryKey: boolean;
  secondaryKeyLabel: string | null;
  healthCheckUrl: string | null;
  capabilities: Record<string, unknown>;
  pricingPerUnit: number | null;
  pricingUnit: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  sortOrder: number;
  logoUrl?: string | null;
  providerType?: string | null;
  apiBaseUrl?: string | null;
  organizationId?: string | null;
  supportedModels?: string[];
  defaultModel?: string | null;
  generationDefaults?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  quotas?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
  circuitBreaker?: Record<string, unknown>;
  priority?: number;
  fallbackPriority?: number;
  enabled?: boolean;
  byokEnabled?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsImageGeneration?: boolean;
  supportsFunctionCalling?: boolean;
  supportsJsonMode?: boolean;
  apiFormat?: string;
  endpointPath?: string;
  authType?: string;
  queryParamName?: string | null;
  authHeaderName?: string;
  authHeaderTemplate?: string;
  requestTemplate?: Record<string, unknown>;
  responseMapping?: Record<string, unknown>;
  healthStatus?: string;
  apiKeyConfigured?: boolean;
  isDefault?: boolean;
  dailyRequestLimit?: number | null;
  monthlyRequestLimit?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiProviderRuntimeConfig extends AiProviderCatalogEntry {
  platformApiKey: string | null;
  platformKeyAvailable: boolean;
}

export interface AiProviderPreset {
  displayName: string;
  providerKey: string;
  providerType: string;
  category: string;
  apiBaseUrl: string;
  endpointPath: string;
  authType: 'bearer' | 'x-api-key' | 'query-param' | 'none';
  authHeaderName?: string;
  defaultModel: string;
  supportedModels: string[];
  notes: string;
}

@Injectable()
export class AiProviderRegistryService {
  private readonly logger = new Logger(AiProviderRegistryService.name);

  // In-memory cache of approved providers (refreshed on writes)
  private approvedProvidersCache: AiProviderCatalogEntry[] = [];
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly audit: AuditService,
  ) {}

  getProviderPresets(): AiProviderPreset[] {
    return [
      {
        displayName: 'Gemini',
        providerKey: 'gemini',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: 'gemini-2.0-flash',
        supportedModels: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
        notes: 'OpenAI-compatible Gemini endpoint; admin supplies API key.',
      },
      {
        displayName: 'Groq',
        providerKey: 'groq',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://api.groq.com/openai/v1',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: 'llama-3.3-70b-versatile',
        supportedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
        notes: 'Low-latency OpenAI-compatible chat completions.',
      },
      {
        displayName: 'OpenRouter',
        providerKey: 'openrouter',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://openrouter.ai/api/v1',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: 'openai/gpt-4o-mini',
        supportedModels: ['openai/gpt-4o-mini', 'meta-llama/llama-3.1-70b-instruct'],
        notes: 'Gateway for many hosted models.',
      },
      {
        displayName: 'Cerebras',
        providerKey: 'cerebras',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://api.cerebras.ai/v1',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: 'llama3.1-8b',
        supportedModels: ['llama3.1-8b', 'llama3.1-70b'],
        notes: 'OpenAI-compatible Cerebras inference.',
      },
      {
        displayName: 'Cloudflare Workers AI',
        providerKey: 'cloudflare-workers-ai',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{{accountId}}/ai/v1',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: '@cf/meta/llama-3.1-8b-instruct',
        supportedModels: ['@cf/meta/llama-3.1-8b-instruct'],
        notes: 'Replace {{accountId}} in the base URL before saving.',
      },
      {
        displayName: 'Together AI',
        providerKey: 'together-ai',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://api.together.xyz/v1',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        supportedModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
        notes: 'OpenAI-compatible Together AI chat.',
      },
      {
        displayName: 'Ollama',
        providerKey: 'ollama',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'http://localhost:11434/v1',
        endpointPath: '/chat/completions',
        authType: 'none',
        defaultModel: 'llama3.1',
        supportedModels: ['llama3.1', 'mistral', 'qwen2.5-coder'],
        notes: 'Local OpenAI-compatible Ollama endpoint.',
      },
      {
        displayName: 'DeepSeek',
        providerKey: 'deepseek',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://api.deepseek.com/v1',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: 'deepseek-chat',
        supportedModels: ['deepseek-chat', 'deepseek-reasoner'],
        notes: 'OpenAI-compatible DeepSeek API.',
      },
      {
        displayName: 'Mistral',
        providerKey: 'mistral',
        providerType: 'chat',
        category: 'reasoning',
        apiBaseUrl: 'https://api.mistral.ai/v1',
        endpointPath: '/chat/completions',
        authType: 'bearer',
        defaultModel: 'mistral-small-latest',
        supportedModels: ['mistral-small-latest', 'mistral-large-latest'],
        notes: 'OpenAI-compatible Mistral chat endpoint.',
      },
    ];
  }

  // ── Admin: Create Provider ────────────────────────────────────────────────

  async createProvider(
    dto: CreateProviderDto,
    adminId: string,
  ): Promise<AiProviderCatalogEntry> {
    const existing = await this.db.query(
      'SELECT id FROM ai_provider_catalog WHERE provider_key = $1',
      [dto.providerKey],
    );
    if (existing.rows.length > 0) {
      throw new ConflictException(`Provider '${dto.providerKey}' already exists`);
    }

    const extended = this.toExtendedColumns(dto);
    const encrypted = dto.apiKey ? this.encrypt(dto.apiKey) : null;

    const result = await this.db.query<AiProviderCatalogEntry>(
      `INSERT INTO ai_provider_catalog (
         provider_key, display_name, category, description, sdk_class,
         base_url, docs_url, status, requires_secondary_key, secondary_key_label,
         health_check_url, capabilities, pricing_per_unit, pricing_unit, sort_order,
         logo_url, provider_type, api_base_url, encrypted_api_key, api_key_iv,
         api_key_auth_tag, organization_id, supported_models, default_model,
         generation_defaults, pricing, quotas, rate_limits, circuit_breaker,
         priority, fallback_priority, is_enabled, byok_enabled,
         supports_streaming, supports_vision, supports_image_generation,
         supports_function_calling, supports_json_mode, api_format, endpoint_path,
         auth_header_name, auth_header_template, request_template, response_mapping,
         daily_budget, monthly_budget, auth_type, query_param_name,
         daily_request_limit, monthly_request_limit, is_default
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
         $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,
         $47,$48,$49,$50,$51)
       RETURNING *`,
      [
        dto.providerKey, dto.displayName, dto.category,
        dto.description ?? null, dto.sdkClass ?? null,
        dto.baseUrl ?? null, dto.docsUrl ?? null,
        dto.enabled === false ? 'disabled' : 'pending',
        dto.requiresSecondaryKey ?? false,
        dto.secondaryKeyLabel ?? null,
        dto.healthCheckUrl ?? dto.healthCheckEndpoint ?? null,
        JSON.stringify(dto.capabilities ?? {}),
        dto.pricingPerUnit ?? null, dto.pricingUnit ?? null,
        dto.sortOrder ?? 0,
        dto.logoUrl ?? null,
        dto.providerType ?? extended.providerType,
        dto.apiBaseUrl ?? dto.baseUrl ?? null,
        encrypted?.ciphertext ?? null,
        encrypted?.iv ?? null,
        encrypted?.authTag ?? null,
        dto.organizationId ?? null,
        JSON.stringify(extended.supportedModels),
        dto.defaultModel ?? null,
        JSON.stringify(extended.generationDefaults),
        JSON.stringify(extended.pricing),
        JSON.stringify(extended.quotas),
        JSON.stringify(extended.rateLimits),
        JSON.stringify(extended.circuitBreaker),
        dto.priority ?? dto.sortOrder ?? 100,
        dto.fallbackPriority ?? dto.priority ?? 100,
        dto.enabled ?? true,
        dto.byokEnabled ?? true,
        dto.supportsStreaming ?? Boolean(dto.capabilities?.supportsStreaming),
        dto.supportsVision ?? Boolean(dto.capabilities?.supportsVision),
        dto.supportsImageGeneration ?? Boolean(dto.capabilities?.supportsImages),
        dto.supportsFunctionCalling ?? Boolean(dto.capabilities?.supportsFunctionCalling),
        dto.supportsJsonMode ?? Boolean(dto.capabilities?.supportsJsonMode),
        dto.apiFormat ?? 'openai_compatible',
        dto.endpointPath ?? '/chat/completions',
        dto.authHeaderName ?? 'Authorization',
        dto.authHeaderTemplate ?? 'Bearer {{apiKey}}',
        JSON.stringify(dto.requestTemplate ?? {}),
        JSON.stringify(dto.responseMapping ?? {}),
        dto.dailyBudget ?? null,
        dto.monthlyBudget ?? null,
        dto.authType ?? 'bearer',
        dto.queryParamName ?? null,
        dto.dailyRequestLimit ?? dto.requestsPerDay ?? null,
        dto.monthlyRequestLimit ?? null,
        dto.isDefault ?? false,
      ],
    );

    if (dto.isDefault === true) {
      await this.setDefaultProvider(result.rows[0].id, adminId);
    }

    await this.auditProviderAction(
      result.rows[0].id,
      adminId,
      'submitted',
      null,
      result.rows[0].status,
      dto.description,
    );
    this.invalidateCache();

    this.logger.log(`[ADMIN] Provider created: ${dto.providerKey} by admin ${adminId}`);
    return this.mapRow(result.rows[0]);
  }

  // ── Admin: Approve Provider ───────────────────────────────────────────────

  async approveProvider(
    providerId: string,
    dto: ApproveProviderDto,
    adminId: string,
  ): Promise<AiProviderCatalogEntry> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);
    if (provider.status === 'approved') {
      throw new ConflictException('Provider is already approved');
    }

    const result = await this.db.query(
      `UPDATE ai_provider_catalog
       SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [adminId, providerId],
    );

    await this.auditProviderAction(providerId, adminId, 'approved', provider.status, 'approved', dto.notes);
    this.invalidateCache();

    this.logger.log(`[ADMIN] Provider APPROVED: ${provider.provider_key} by admin ${adminId}`);
    return this.mapRow(result.rows[0]);
  }

  // ── Admin: Disable Provider ───────────────────────────────────────────────

  async disableProvider(
    providerId: string,
    reason: string,
    adminId: string,
  ): Promise<void> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    await this.db.query(
      `UPDATE ai_provider_catalog
       SET status = 'disabled', disabled_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [reason, providerId],
    );

    // Also disable all user connections to this provider
    await this.db.query(
      `UPDATE user_ai_provider_connections
       SET connection_status = 'disabled', updated_at = NOW()
       WHERE provider_id = $1 AND is_active = true`,
      [providerId],
    );

    await this.auditProviderAction(providerId, adminId, 'disabled', provider.status, 'disabled', reason);
    this.invalidateCache();

    this.logger.warn(`[ADMIN] Provider DISABLED: ${provider.provider_key} — reason: ${reason}`);
  }

  // ── Admin: Update Provider ────────────────────────────────────────────────

  async updateProvider(
    providerId: string,
    dto: UpdateProviderDto,
    adminId: string,
  ): Promise<AiProviderCatalogEntry> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.displayName !== undefined) { setClauses.push(`display_name = $${idx++}`); values.push(dto.displayName); }
    if (dto.description !== undefined) { setClauses.push(`description = $${idx++}`); values.push(dto.description); }
    if (dto.category !== undefined)    { setClauses.push(`category = $${idx++}`); values.push(dto.category); }
    if (dto.baseUrl !== undefined)     { setClauses.push(`base_url = $${idx++}`); values.push(dto.baseUrl); }
    if (dto.apiBaseUrl !== undefined)  { setClauses.push(`api_base_url = $${idx++}`); values.push(dto.apiBaseUrl); }
    if (dto.docsUrl !== undefined)     { setClauses.push(`docs_url = $${idx++}`); values.push(dto.docsUrl); }
    if (dto.logoUrl !== undefined)     { setClauses.push(`logo_url = $${idx++}`); values.push(dto.logoUrl); }
    if (dto.providerType !== undefined){ setClauses.push(`provider_type = $${idx++}`); values.push(dto.providerType); }
    if (dto.organizationId !== undefined){ setClauses.push(`organization_id = $${idx++}`); values.push(dto.organizationId); }
    if (dto.healthCheckEndpoint !== undefined){ setClauses.push(`health_check_url = $${idx++}`); values.push(dto.healthCheckEndpoint); }
    if (dto.capabilities !== undefined){ setClauses.push(`capabilities = $${idx++}`); values.push(JSON.stringify(dto.capabilities)); }
    if (dto.supportedModels !== undefined || dto.modelList !== undefined) {
      setClauses.push(`supported_models = $${idx++}`);
      values.push(JSON.stringify(dto.supportedModels ?? dto.modelList ?? []));
    }
    if (dto.defaultModel !== undefined) { setClauses.push(`default_model = $${idx++}`); values.push(dto.defaultModel); }
    const extended = this.toExtendedColumns(dto);
    if (this.hasGenerationDefaults(dto)) { setClauses.push(`generation_defaults = $${idx++}`); values.push(JSON.stringify(extended.generationDefaults)); }
    if (dto.quotas !== undefined || dto.dailyBudget !== undefined || dto.monthlyBudget !== undefined) {
      setClauses.push(`quotas = $${idx++}`);
      values.push(JSON.stringify(extended.quotas));
    }
    if (dto.rateLimits !== undefined || dto.requestsPerMinute !== undefined || dto.requestsPerDay !== undefined) {
      setClauses.push(`rate_limits = $${idx++}`);
      values.push(JSON.stringify(extended.rateLimits));
    }
    if (dto.circuitBreakerSettings !== undefined) { setClauses.push(`circuit_breaker = $${idx++}`); values.push(JSON.stringify(dto.circuitBreakerSettings)); }
    if (dto.costPer1KTokens !== undefined) { setClauses.push(`pricing = $${idx++}`); values.push(JSON.stringify(extended.pricing)); }
    if (dto.pricingPerUnit !== undefined){ setClauses.push(`pricing_per_unit = $${idx++}`); values.push(dto.pricingPerUnit); }
    if (dto.pricingUnit !== undefined)  { setClauses.push(`pricing_unit = $${idx++}`); values.push(dto.pricingUnit); }
    if (dto.sortOrder !== undefined)    { setClauses.push(`sort_order = $${idx++}`); values.push(dto.sortOrder); }
    if (dto.priority !== undefined)     { setClauses.push(`priority = $${idx++}`); values.push(dto.priority); }
    if (dto.fallbackPriority !== undefined){ setClauses.push(`fallback_priority = $${idx++}`); values.push(dto.fallbackPriority); }
    if (dto.enabled !== undefined)      { setClauses.push(`is_enabled = $${idx++}`); values.push(dto.enabled); }
    if (dto.byokEnabled !== undefined)  { setClauses.push(`byok_enabled = $${idx++}`); values.push(dto.byokEnabled); }
    if (dto.supportsStreaming !== undefined){ setClauses.push(`supports_streaming = $${idx++}`); values.push(dto.supportsStreaming); }
    if (dto.supportsVision !== undefined){ setClauses.push(`supports_vision = $${idx++}`); values.push(dto.supportsVision); }
    if (dto.supportsImageGeneration !== undefined){ setClauses.push(`supports_image_generation = $${idx++}`); values.push(dto.supportsImageGeneration); }
    if (dto.supportsFunctionCalling !== undefined){ setClauses.push(`supports_function_calling = $${idx++}`); values.push(dto.supportsFunctionCalling); }
    if (dto.supportsJsonMode !== undefined){ setClauses.push(`supports_json_mode = $${idx++}`); values.push(dto.supportsJsonMode); }
    if (dto.apiFormat !== undefined)    { setClauses.push(`api_format = $${idx++}`); values.push(dto.apiFormat); }
    if (dto.endpointPath !== undefined) { setClauses.push(`endpoint_path = $${idx++}`); values.push(dto.endpointPath); }
    if (dto.authHeaderName !== undefined){ setClauses.push(`auth_header_name = $${idx++}`); values.push(dto.authHeaderName); }
    if (dto.authType !== undefined)      { setClauses.push(`auth_type = $${idx++}`); values.push(dto.authType); }
    if (dto.queryParamName !== undefined){ setClauses.push(`query_param_name = $${idx++}`); values.push(dto.queryParamName); }
    if (dto.authHeaderTemplate !== undefined){ setClauses.push(`auth_header_template = $${idx++}`); values.push(dto.authHeaderTemplate); }
    if (dto.requestTemplate !== undefined){ setClauses.push(`request_template = $${idx++}`); values.push(JSON.stringify(dto.requestTemplate)); }
    if (dto.responseMapping !== undefined){ setClauses.push(`response_mapping = $${idx++}`); values.push(JSON.stringify(dto.responseMapping)); }
    if (dto.dailyBudget !== undefined)  { setClauses.push(`daily_budget = $${idx++}`); values.push(dto.dailyBudget); }
    if (dto.monthlyBudget !== undefined){ setClauses.push(`monthly_budget = $${idx++}`); values.push(dto.monthlyBudget); }
    if (dto.dailyRequestLimit !== undefined){ setClauses.push(`daily_request_limit = $${idx++}`); values.push(dto.dailyRequestLimit); }
    if (dto.monthlyRequestLimit !== undefined){ setClauses.push(`monthly_request_limit = $${idx++}`); values.push(dto.monthlyRequestLimit); }
    if (dto.isDefault !== undefined)    { setClauses.push(`is_default = $${idx++}`); values.push(dto.isDefault); }
    if (dto.apiKey !== undefined) {
      const encrypted = this.encrypt(dto.apiKey);
      setClauses.push(`encrypted_api_key = $${idx++}`); values.push(encrypted.ciphertext);
      setClauses.push(`api_key_iv = $${idx++}`); values.push(encrypted.iv);
      setClauses.push(`api_key_auth_tag = $${idx++}`); values.push(encrypted.authTag);
      setClauses.push(`api_key_version = api_key_version + 1`);
    }

    if (setClauses.length === 0) return this.mapRow(provider);

    setClauses.push(`updated_at = NOW()`);
    values.push(providerId);

    const result = await this.db.query(
      `UPDATE ai_provider_catalog SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );

    this.invalidateCache();
    this.logger.log(`[ADMIN] Provider updated: ${provider.provider_key} by admin ${adminId}`);
    await this.auditProviderAction(
      providerId,
      adminId,
      dto.apiKey !== undefined ? 'key_rotated' : 'updated',
      provider.status,
      result.rows[0].status,
      dto.apiKey !== undefined ? 'Provider API key rotated securely' : 'Provider metadata updated',
    );
    if (dto.isDefault === true) {
      await this.setDefaultProvider(providerId, adminId);
    }
    return this.mapRow(result.rows[0]);
  }

  async setDefaultProvider(providerId: string, adminId: string): Promise<AiProviderCatalogEntry> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);
    await this.db.query(
      `UPDATE ai_provider_catalog
       SET is_default = false, updated_at = NOW()
       WHERE category = $1 AND id <> $2`,
      [provider.category, providerId],
    );
    const result = await this.db.query(
      `UPDATE ai_provider_catalog
       SET is_default = true, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [providerId],
    );
    await this.auditProviderAction(providerId, adminId, 'updated', provider.status, result.rows[0].status, 'Provider set as default');
    this.invalidateCache();
    return this.mapRow(result.rows[0]);
  }

  async deleteProvider(providerId: string, adminId: string): Promise<void> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);
    await this.db.query(
      `UPDATE ai_provider_catalog
       SET status = 'deprecated', is_enabled = false, disabled_reason = 'Deleted by admin', updated_at = NOW()
       WHERE id = $1`,
      [providerId],
    );
    await this.auditProviderAction(providerId, adminId, 'deleted', provider.status, 'deprecated', 'Soft deleted by admin');
    this.invalidateCache();
  }

  // ── Public: List Approved Providers (for user connection UI) ─────────────

  async listApprovedProviders(): Promise<AiProviderCatalogEntry[]> {
    if (Date.now() < this.cacheExpiresAt && this.approvedProvidersCache.length > 0) {
      return this.approvedProvidersCache;
    }

    const result = await this.db.query(
      `SELECT * FROM ai_provider_catalog
       WHERE status = 'approved' AND COALESCE(is_enabled, true) = true
       ORDER BY priority ASC, fallback_priority ASC, sort_order ASC, display_name ASC`,
    );

    this.approvedProvidersCache = result.rows.map(r => this.mapRow(r));
    this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
    return this.approvedProvidersCache;
  }

  // ── Admin: List All Providers ─────────────────────────────────────────────

  async listAllProviders(): Promise<AiProviderCatalogEntry[]> {
    const result = await this.db.query(
      `SELECT * FROM ai_provider_catalog ORDER BY priority ASC, fallback_priority ASC, sort_order ASC, display_name ASC`,
    );
    return result.rows.map(r => this.mapRow(r));
  }

  // ── Validate Provider Is Approved ────────────────────────────────────────

  async assertProviderApproved(providerId: string): Promise<AiProviderCatalogEntry> {
    const result = await this.db.query(
      `SELECT * FROM ai_provider_catalog WHERE id = $1`,
      [providerId],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }
    const provider = this.mapRow(result.rows[0]);
    if (provider.status !== 'approved' || provider.enabled === false) {
      throw new ForbiddenException(
        `Provider '${provider.displayName}' is not approved for user connections (status: ${provider.status})`,
      );
    }
    return provider;
  }

  async exportProviders(adminId: string): Promise<{ exportedAt: string; providers: AiProviderCatalogEntry[] }> {
    const providers = await this.listAllProviders();
    await Promise.all(providers.map(p =>
      this.auditProviderAction(p.id, adminId, 'exported', p.status, p.status, 'Provider configuration exported'),
    ));
    return { exportedAt: new Date().toISOString(), providers };
  }

  async importProviders(dto: ImportProvidersDto, adminId: string): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const provider of dto.providers) {
      try {
        await this.createProvider(provider, adminId);
        imported += 1;
      } catch (err) {
        if (err instanceof ConflictException) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    return { imported, skipped };
  }

  async testProviderConnectivity(providerId: string, adminId: string): Promise<{ status: string; latencyMs: number | null; error?: string }> {
    const raw = await this.getProviderByIdRaw(providerId);
    if (!raw) throw new NotFoundException(`Provider ${providerId} not found`);
    const provider = this.mapRow(raw);
    const url = provider.healthCheckUrl ?? this.joinUrl(provider.apiBaseUrl ?? provider.baseUrl, provider.endpointPath ?? '/');
    if (!url) throw new BadRequestException('Provider has no health check endpoint or API base URL');

    const start = Date.now();
    try {
      const headers: Record<string, string> = {};
      const apiKey = raw.encrypted_api_key
        ? this.decrypt(raw.encrypted_api_key, raw.api_key_iv, raw.api_key_auth_tag)
        : null;
      if (apiKey) {
        headers[provider.authHeaderName ?? 'Authorization'] =
          (provider.authHeaderTemplate ?? 'Bearer {{apiKey}}').replace('{{apiKey}}', apiKey);
      }
      const res = await fetch(url, {
        method: raw.health_check_method ?? 'GET',
        headers,
        signal: AbortSignal.timeout(Number(provider.generationDefaults?.timeoutMs ?? 10_000)),
      });
      const latencyMs = Date.now() - start;
      const status = res.status >= 200 && res.status < 500 ? 'healthy' : 'down';
      await this.recordHealthSnapshot(providerId, status as 'healthy' | 'down', latencyMs, res.ok ? undefined : `HTTP ${res.status}`);
      await this.db.query(
        `UPDATE ai_provider_catalog SET health_status = $1, last_health_check_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [status, providerId],
      );
      await this.auditProviderAction(providerId, adminId, 'connectivity_tested', provider.status, provider.status, status);
      return { status, latencyMs, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error = (err as Error).message;
      await this.recordHealthSnapshot(providerId, 'down', latencyMs, error);
      await this.db.query(
        `UPDATE ai_provider_catalog SET health_status = 'down', last_health_check_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [providerId],
      );
      await this.auditProviderAction(providerId, adminId, 'connectivity_tested', provider.status, provider.status, error);
      return { status: 'down', latencyMs, error };
    }
  }

  async getRuntimeProviderByKey(providerKey: string): Promise<AiProviderRuntimeConfig | null> {
    const result = await this.db.query(
      `SELECT * FROM ai_provider_catalog
       WHERE provider_key = $1
         AND status = 'approved'
         AND COALESCE(is_enabled, true) = true
       LIMIT 1`,
      [providerKey],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const mapped = this.mapRow(row);
    const platformApiKey = row.encrypted_api_key
      ? this.decrypt(row.encrypted_api_key, row.api_key_iv, row.api_key_auth_tag)
      : null;
    return {
      ...mapped,
      platformApiKey,
      platformKeyAvailable: Boolean(platformApiKey),
    };
  }

  // ── Provider Health Snapshot ──────────────────────────────────────────────

  async recordHealthSnapshot(
    providerId: string,
    status: 'healthy' | 'degraded' | 'down',
    latencyMs: number | null,
    error?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_provider_health_snapshots (provider_id, status, latency_ms, error_message)
       VALUES ($1, $2, $3, $4)`,
      [providerId, status, latencyMs, error ?? null],
    );

    // Prune snapshots older than 7 days
    await this.db.query(
      `DELETE FROM ai_provider_health_snapshots
       WHERE provider_id = $1 AND checked_at < NOW() - INTERVAL '7 days'`,
      [providerId],
    );
  }

  async getProviderHealthSummary(): Promise<
    Array<{ providerId: string; providerKey: string; latestStatus: string; latencyMs: number | null; checkedAt: Date }>
  > {
    const result = await this.db.query(
      `SELECT DISTINCT ON (s.provider_id)
         s.provider_id, c.provider_key, s.status AS latest_status, s.latency_ms, s.checked_at
       FROM ai_provider_health_snapshots s
       JOIN ai_provider_catalog c ON c.id = s.provider_id
       ORDER BY s.provider_id, s.checked_at DESC`,
    );
    return result.rows.map(r => ({
      providerId:    r.provider_id,
      providerKey:   r.provider_key,
      latestStatus:  r.latest_status,
      latencyMs:     r.latency_ms,
      checkedAt:     r.checked_at,
    }));
  }

  async getProviderUsageAnalytics(days = 30): Promise<any> {
    const result = await this.db.query(
      `SELECT
         e.provider_key,
         COUNT(*)::int AS total_requests,
         SUM(e.total_tokens)::bigint AS total_tokens,
         COALESCE(SUM(e.cost_usd), 0)::numeric AS total_cost_usd,
         AVG(e.latency_ms)::int AS avg_latency_ms,
         COUNT(*) FILTER (WHERE e.success = true)::int AS success_count,
         COUNT(*) FILTER (WHERE e.success = false)::int AS failure_count,
         MAX(e.created_at) AS last_used_at
       FROM user_ai_usage_events e
       WHERE e.created_at > NOW() - ($1 || ' days')::INTERVAL
       GROUP BY e.provider_key
       ORDER BY total_requests DESC`,
      [days],
    );

    return {
      period: `${days}d`,
      providers: result.rows.map((row: any) => {
        const total = Number(row.total_requests ?? 0);
        const failures = Number(row.failure_count ?? 0);
        return {
          providerKey: row.provider_key,
          requests: total,
          tokens: Number(row.total_tokens ?? 0),
          costUsd: Number(row.total_cost_usd ?? 0),
          avgLatencyMs: Number(row.avg_latency_ms ?? 0),
          successRate: total > 0 ? (total - failures) / total : 0,
          failureRate: total > 0 ? failures / total : 0,
          lastUsedAt: row.last_used_at,
        };
      }),
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private async getProviderByIdRaw(id: string): Promise<any | null> {
    const result = await this.db.query(
      'SELECT * FROM ai_provider_catalog WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  private async auditProviderAction(
    providerId: string,
    adminId: string,
    action: string,
    oldStatus: string | null,
    newStatus: string,
    reason: string | null | undefined,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_provider_approval_log (provider_id, admin_id, action, old_status, new_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [providerId, adminId, action, oldStatus, newStatus, reason ?? null],
    );
  }

  private getMasterKey(): Buffer {
    const key = process.env.ENCRYPTION_MASTER_KEY;
    if (!key || key.length < 32) {
      throw new Error('ENCRYPTION_MASTER_KEY not set or too short');
    }
    return Buffer.from(key.slice(0, 64), 'hex');
  }

  private encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, this.getMasterKey(), iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: enc.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  private decrypt(ciphertext: string, iv: string, authTag: string): string {
    const decipher = crypto.createDecipheriv(ALGORITHM, this.getMasterKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private json<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
      try { return JSON.parse(value) as T; } catch { return fallback; }
    }
    return value as T;
  }

  private toExtendedColumns(dto: Partial<CreateProviderDto & UpdateProviderDto>) {
    const supportedModels = dto.supportedModels ?? dto.modelList ?? [];
    return {
      providerType: dto.providerType ?? this.categoryToProviderType(dto.category),
      supportedModels,
      generationDefaults: {
        maxTokens: dto.maxTokens,
        temperature: dto.temperature,
        topP: dto.topP,
        timeoutMs: dto.timeoutMs,
        retryCount: dto.retryCount,
      },
      pricing: {
        costPer1KTokens: dto.costPer1KTokens ?? dto.pricingPerUnit,
        pricingUnit: dto.pricingUnit,
      },
      quotas: {
        ...(dto.quotas ?? {}),
        dailyBudget: dto.dailyBudget,
        monthlyBudget: dto.monthlyBudget,
      },
      rateLimits: {
        ...(dto.rateLimits ?? {}),
        requestsPerMinute: dto.requestsPerMinute,
        requestsPerDay: dto.requestsPerDay,
      },
      circuitBreaker: dto.circuitBreakerSettings ?? {},
    };
  }

  private hasGenerationDefaults(dto: Partial<CreateProviderDto & UpdateProviderDto>): boolean {
    return dto.maxTokens !== undefined ||
      dto.temperature !== undefined ||
      dto.topP !== undefined ||
      dto.timeoutMs !== undefined ||
      dto.retryCount !== undefined;
  }

  private categoryToProviderType(category?: string): string {
    switch (category) {
      case 'image_generation': return 'image';
      case 'video_generation': return 'video';
      case 'voice': return 'audio';
      case 'embedding': return 'embedding';
      case 'multimodal': return 'vision';
      default: return 'chat';
    }
  }

  private joinUrl(base?: string | null, path?: string | null): string | null {
    if (!base) return null;
    if (!path) return base;
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private invalidateCache(): void {
    this.approvedProvidersCache = [];
    this.cacheExpiresAt = 0;
  }

  private mapRow(row: any): AiProviderCatalogEntry {
    return {
      id:                   row.id,
      providerKey:          row.provider_key,
      displayName:          row.display_name,
      category:             row.category,
      description:          row.description,
      sdkClass:             row.sdk_class,
      baseUrl:              row.base_url,
      docsUrl:              row.docs_url,
      status:               row.status,
      requiresSecondaryKey: row.requires_secondary_key,
      secondaryKeyLabel:    row.secondary_key_label,
      healthCheckUrl:       row.health_check_url ?? null,
      capabilities:         typeof row.capabilities === 'string'
                              ? JSON.parse(row.capabilities)
                              : (row.capabilities ?? {}),
      pricingPerUnit:       row.pricing_per_unit ? Number(row.pricing_per_unit) : null,
      pricingUnit:          row.pricing_unit,
      approvedBy:           row.approved_by,
      approvedAt:           row.approved_at,
      sortOrder:            row.sort_order,
      logoUrl:              row.logo_url ?? null,
      providerType:         row.provider_type ?? this.categoryToProviderType(row.category),
      apiBaseUrl:           row.api_base_url ?? row.base_url ?? null,
      organizationId:       row.organization_id ?? null,
      supportedModels:      this.json<string[]>(row.supported_models, []),
      defaultModel:         row.default_model ?? null,
      generationDefaults:   this.json<Record<string, unknown>>(row.generation_defaults, {}),
      pricing:              this.json<Record<string, unknown>>(row.pricing, {}),
      quotas:               this.json<Record<string, unknown>>(row.quotas, {}),
      rateLimits:           this.json<Record<string, unknown>>(row.rate_limits, {}),
      circuitBreaker:       this.json<Record<string, unknown>>(row.circuit_breaker, {}),
      priority:             Number(row.priority ?? row.sort_order ?? 100),
      fallbackPriority:     Number(row.fallback_priority ?? row.priority ?? 100),
      enabled:              row.is_enabled ?? row.status === 'approved',
      byokEnabled:          row.byok_enabled ?? true,
      supportsStreaming:    row.supports_streaming ?? Boolean(row.capabilities?.supportsStreaming),
      supportsVision:       row.supports_vision ?? Boolean(row.capabilities?.supportsVision),
      supportsImageGeneration: row.supports_image_generation ?? Boolean(row.capabilities?.supportsImages),
      supportsFunctionCalling: row.supports_function_calling ?? Boolean(row.capabilities?.supportsFunctionCalling),
      supportsJsonMode:     row.supports_json_mode ?? Boolean(row.capabilities?.supportsJsonMode),
      apiFormat:            row.api_format ?? 'openai_compatible',
      endpointPath:         row.endpoint_path ?? '/chat/completions',
      authType:             row.auth_type ?? 'bearer',
      queryParamName:       row.query_param_name ?? null,
      authHeaderName:       row.auth_header_name ?? 'Authorization',
      authHeaderTemplate:   row.auth_header_template ?? 'Bearer {{apiKey}}',
      requestTemplate:      this.json<Record<string, unknown>>(row.request_template, {}),
      responseMapping:      this.json<Record<string, unknown>>(row.response_mapping, {}),
      healthStatus:         row.health_status ?? 'unknown',
      apiKeyConfigured:     Boolean(row.encrypted_api_key),
      isDefault:            Boolean(row.is_default),
      dailyRequestLimit:    row.daily_request_limit ? Number(row.daily_request_limit) : null,
      monthlyRequestLimit:  row.monthly_request_limit ? Number(row.monthly_request_limit) : null,
      createdAt:            row.created_at,
      updatedAt:            row.updated_at,
    };
  }
}
