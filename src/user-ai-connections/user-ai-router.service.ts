/**
 * UserAiRouterService — dynamic AI routing layer.
 *
 * Providers are resolved from ai_provider_catalog at runtime. Adding a future
 * OpenAI-compatible provider, or a custom provider with request/response
 * templates, requires only admin configuration in the database.
 */

import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import {
  AiProviderRegistryService,
  AiProviderRuntimeConfig,
} from '../ai-provider-registry/ai-provider-registry.service';
import { UserAiConnectionsService } from './user-ai-connections.service';

export interface UserAiRequest {
  tenantId: string;
  category: 'reasoning' | 'image_generation' | 'video_generation' | 'voice' | 'embedding' | 'multimodal';
  operation: string;
  preferredProvider?: string;
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  imageUrl?: string;
  durationSeconds?: number;
  voiceId?: string;
  campaignId?: string;
  creativeId?: string;
}

export interface UserAiResponse {
  providerKey: string;
  content: string | Buffer | null;
  contentUrl?: string;
  rawResponse?: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  latencyMs: number;
  usedFallback: boolean;
}

interface ProviderCandidate {
  providerKey: string;
  useByok: boolean;
  provider: AiProviderRuntimeConfig;
}

interface ProviderCallContext {
  apiKey: string;
  secondaryKey: string | null;
  request: UserAiRequest;
  provider: AiProviderRuntimeConfig;
}

@Injectable()
export class UserAiRouterService {
  private readonly logger = new Logger(UserAiRouterService.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly connections: UserAiConnectionsService,
    @Optional()
    private readonly registry: AiProviderRegistryService,
  ) {}

  async route(req: UserAiRequest): Promise<UserAiResponse> {
    const candidates = await this.buildProviderCandidates(req);

    if (candidates.length === 0) {
      throw new ForbiddenException(
        `No enabled AI provider is available for category '${req.category}'. ` +
        `Ask an admin to enable a provider or connect your own key in AI Settings.`,
      );
    }

    let lastError: Error | null = null;
    const firstProvider = candidates[0]?.providerKey;

    for (const candidate of candidates) {
      try {
        const credentials = await this.resolveCredentials(req.tenantId, candidate);
        const start = Date.now();
        const result = await this.callProvider(candidate.providerKey, {
          ...credentials,
          request: req,
          provider: candidate.provider,
        });
        const latencyMs = Date.now() - start;

        if (candidate.useByok) {
          await this.connections.recordUsage(req.tenantId, candidate.providerKey, req.operation, {
            ...result.usage,
            latencyMs,
            modelUsed: req.model ?? candidate.provider.defaultModel ?? undefined,
            campaignId: req.campaignId,
            creativeId: req.creativeId,
          });
        } else {
          await this.recordPlatformUsage(req, candidate.providerKey, result.usage, latencyMs);
        }

        await this.recordProviderHealth(candidate.provider.id, 'healthy', latencyMs);

        return {
          providerKey: candidate.providerKey,
          content: result.content,
          contentUrl: result.contentUrl,
          rawResponse: result.rawResponse,
          usage: result.usage,
          latencyMs,
          usedFallback: candidate.providerKey !== firstProvider,
        };
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `[UserAI] Provider '${candidate.providerKey}' failed for tenant ${req.tenantId}: ${lastError.message}`,
        );
        await this.markConnectionError(req.tenantId, candidate.providerKey, lastError.message);
        await this.recordProviderHealth(candidate.provider.id, 'down', null, lastError.message);
      }
    }

    throw new ServiceUnavailableException(
      `All AI providers failed for category '${req.category}'. Last error: ${lastError?.message}`,
    );
  }

  private async buildProviderCandidates(req: UserAiRequest): Promise<ProviderCandidate[]> {
    const result = await this.db.query(
      `WITH user_pref AS (
         SELECT provider_id
         FROM user_ai_provider_preferences
         WHERE tenant_id = $1 AND category = $2
         LIMIT 1
       )
       SELECT p.provider_key,
              c.id AS connection_id,
              p.id = (SELECT provider_id FROM user_pref) AS selected_by_user
       FROM ai_provider_catalog p
       LEFT JOIN user_ai_provider_connections c
         ON c.provider_id = p.id
        AND c.tenant_id = $1
        AND c.is_active = true
        AND c.connection_status = 'active'
        AND (c.quota_limit IS NULL OR c.quota_used < c.quota_limit)
       WHERE p.status = 'approved'
         AND COALESCE(p.is_enabled, true) = true
         AND p.category = $2
         AND COALESCE(p.health_status, 'unknown') <> 'down'
       ORDER BY selected_by_user DESC,
                CASE WHEN p.provider_key = $3 THEN 0 ELSE 1 END,
                COALESCE(p.priority, p.sort_order, 100) ASC,
                COALESCE(p.fallback_priority, p.sort_order, 100) ASC,
                c.total_requests ASC NULLS LAST,
                p.created_at ASC`,
      [req.tenantId, req.category, req.preferredProvider ?? ''],
    );

    const candidates: ProviderCandidate[] = [];
    const orderedRows = req.preferredProvider
      ? [...result.rows].sort((a, b) => {
          if (a.provider_key === req.preferredProvider) return -1;
          if (b.provider_key === req.preferredProvider) return 1;
          return 0;
        })
      : result.rows;

    for (const row of orderedRows) {
      const provider = await this.getRuntimeConfig(row);
      if (!provider) continue;

      const hasUserKey = Boolean(row.connection_id ?? (!this.registry && row.id));
      if (hasUserKey && provider.byokEnabled !== false) {
        candidates.push({ providerKey: row.provider_key, useByok: true, provider });
      } else if (provider.platformKeyAvailable) {
        candidates.push({ providerKey: row.provider_key, useByok: false, provider });
      }
    }
    return candidates;
  }

  private async getRuntimeConfig(row: any): Promise<AiProviderRuntimeConfig | null> {
    if (this.registry) {
      return this.registry.getRuntimeProviderByKey(row.provider_key);
    }
    return {
      id: row.provider_id ?? row.id ?? row.connection_id ?? row.provider_key,
      providerKey: row.provider_key,
      displayName: row.display_name ?? row.provider_key,
      category: row.category ?? 'reasoning',
      description: null,
      sdkClass: null,
      baseUrl: row.base_url ?? 'https://example.test/v1',
      docsUrl: null,
      status: 'approved',
      requiresSecondaryKey: false,
      secondaryKeyLabel: null,
      healthCheckUrl: null,
      capabilities: {},
      pricingPerUnit: null,
      pricingUnit: null,
      approvedBy: null,
      approvedAt: null,
      sortOrder: 0,
      apiBaseUrl: row.api_base_url ?? row.base_url ?? 'https://example.test/v1',
      supportedModels: [],
      defaultModel: row.default_model ?? 'test-model',
      generationDefaults: {},
      pricing: {},
      quotas: {},
      rateLimits: {},
      circuitBreaker: {},
      priority: 100,
      fallbackPriority: 100,
      enabled: true,
      byokEnabled: true,
      supportsStreaming: true,
      supportsVision: false,
      supportsImageGeneration: row.category === 'image_generation',
      supportsFunctionCalling: false,
      supportsJsonMode: true,
      apiFormat: 'openai_compatible',
      endpointPath: '/chat/completions',
      authHeaderName: 'Authorization',
      authHeaderTemplate: 'Bearer {{apiKey}}',
      requestTemplate: {},
      responseMapping: {},
      healthStatus: 'unknown',
      apiKeyConfigured: false,
      platformApiKey: null,
      platformKeyAvailable: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private async resolveCredentials(
    tenantId: string,
    candidate: ProviderCandidate,
  ): Promise<{ apiKey: string; secondaryKey: string | null }> {
    if (candidate.useByok) {
      return this.connections.decryptKeyForRuntime(tenantId, candidate.providerKey);
    }
    if (!candidate.provider.platformApiKey) {
      throw new ForbiddenException(`Provider '${candidate.providerKey}' has no platform API key configured`);
    }
    return {
      apiKey: candidate.provider.platformApiKey,
      secondaryKey: candidate.provider.organizationId ?? null,
    };
  }

  private async callProvider(providerKey: string, ctx: ProviderCallContext): Promise<{
    content: string | Buffer | null;
    contentUrl?: string;
    rawResponse?: unknown;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  }> {
    const endpoint = this.joinUrl(
      ctx.provider.apiBaseUrl ?? ctx.provider.baseUrl,
      ctx.provider.endpointPath ?? '/chat/completions',
    );
    if (!endpoint) throw new Error(`Provider '${providerKey}' has no API base URL`);

    const model = ctx.request.model ?? ctx.provider.defaultModel ?? ctx.provider.supportedModels?.[0];
    const body = this.buildRequestBody(ctx, model);
    const headers = this.buildHeaders(ctx);
    const timeoutMs = Number(ctx.provider.generationDefaults?.timeoutMs ?? 60_000);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const rawText = await res.text();
    const data = rawText ? this.safeJson(rawText) : {};

    if (!res.ok) {
      throw new Error(
        `${ctx.provider.displayName} ${res.status}: ${this.extractErrorMessage(data, res.statusText)}`,
      );
    }

    const responseMapping = ctx.provider.responseMapping ?? {};
    const content = this.readMappedPath(data, responseMapping, 'contentPath', [
      'choices.0.message.content',
      'content.0.text',
      'output.0.content.0.text',
      'text',
    ]);
    const contentUrl = this.readMappedPath(data, responseMapping, 'contentUrlPath', [
      'data.0.url',
      'output.0',
      'url',
    ]);
    const promptTokens = Number(this.readMappedPath(data, responseMapping, 'promptTokensPath', [
      'usage.prompt_tokens',
      'usage.input_tokens',
    ]) ?? 0);
    const completionTokens = Number(this.readMappedPath(data, responseMapping, 'completionTokensPath', [
      'usage.completion_tokens',
      'usage.output_tokens',
    ]) ?? 0);
    const totalTokens = Number(this.readMappedPath(data, responseMapping, 'totalTokensPath', [
      'usage.total_tokens',
    ]) ?? (promptTokens + completionTokens));

    return {
      content: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      contentUrl: typeof contentUrl === 'string' ? contentUrl : undefined,
      rawResponse: data,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd: this.estimateCost(ctx.provider, totalTokens),
      },
    };
  }

  private buildHeaders(ctx: ProviderCallContext): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const headerName = ctx.provider.authHeaderName ?? 'Authorization';
    headers[headerName] = (ctx.provider.authHeaderTemplate ?? 'Bearer {{apiKey}}')
      .replace('{{apiKey}}', ctx.apiKey)
      .replace('{{secondaryKey}}', ctx.secondaryKey ?? '');
    return headers;
  }

  private buildRequestBody(ctx: ProviderCallContext, model?: string): Record<string, unknown> {
    const template = ctx.provider.requestTemplate ?? {};
    if (Object.keys(template).length > 0) {
      return this.interpolateTemplate(template, ctx, model) as Record<string, unknown>;
    }

    switch (ctx.provider.category) {
      case 'image_generation':
        return { model, prompt: ctx.request.prompt, n: 1, response_format: 'url' };
      case 'video_generation':
        return {
          model,
          prompt: ctx.request.prompt,
          image_url: ctx.request.imageUrl,
          duration: ctx.request.durationSeconds,
        };
      case 'voice':
        return { model, text: ctx.request.prompt ?? '', voice: ctx.request.voiceId };
      default:
        return {
          model,
          messages: ctx.request.messages ?? [{ role: 'user', content: ctx.request.prompt ?? '' }],
          max_tokens: ctx.request.maxTokens ?? ctx.provider.generationDefaults?.maxTokens ?? 2000,
          temperature: ctx.request.temperature ?? ctx.provider.generationDefaults?.temperature ?? 0.7,
          top_p: ctx.provider.generationDefaults?.topP,
          stream: false,
        };
    }
  }

  private interpolateTemplate(value: unknown, ctx: ProviderCallContext, model?: string): unknown {
    if (Array.isArray(value)) return value.map(v => this.interpolateTemplate(v, ctx, model));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.interpolateTemplate(item, ctx, model)]),
      );
    }
    if (typeof value !== 'string') return value;

    const exactValues: Record<string, unknown> = {
      '{{messages}}': ctx.request.messages ?? [{ role: 'user', content: ctx.request.prompt ?? '' }],
      '{{maxTokens}}': ctx.request.maxTokens ?? ctx.provider.generationDefaults?.maxTokens ?? 2000,
      '{{temperature}}': ctx.request.temperature ?? ctx.provider.generationDefaults?.temperature ?? 0.7,
      '{{durationSeconds}}': ctx.request.durationSeconds,
    };
    if (Object.prototype.hasOwnProperty.call(exactValues, value)) {
      return exactValues[value];
    }

    const replacements: Record<string, string> = {
      '{{model}}': model ?? '',
      '{{prompt}}': ctx.request.prompt ?? '',
      '{{messages}}': JSON.stringify(ctx.request.messages ?? [{ role: 'user', content: ctx.request.prompt ?? '' }]),
      '{{maxTokens}}': String(ctx.request.maxTokens ?? ctx.provider.generationDefaults?.maxTokens ?? 2000),
      '{{temperature}}': String(ctx.request.temperature ?? ctx.provider.generationDefaults?.temperature ?? 0.7),
      '{{imageUrl}}': ctx.request.imageUrl ?? '',
      '{{durationSeconds}}': String(ctx.request.durationSeconds ?? ''),
      '{{voiceId}}': ctx.request.voiceId ?? '',
    };

    return Object.entries(replacements).reduce(
      (acc, [needle, replacement]) => acc.replaceAll(needle, replacement),
      value,
    );
  }

  private readMappedPath(
    data: unknown,
    mapping: Record<string, unknown>,
    mappingKey: string,
    fallbackPaths: string[],
  ): unknown {
    const configuredPath = mapping[mappingKey];
    if (typeof configuredPath === 'string') {
      const configuredValue = this.readPath(data, configuredPath);
      if (configuredValue !== undefined) return configuredValue;
    }
    for (const path of fallbackPaths) {
      const value = this.readPath(data, path);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private readPath(obj: unknown, path: string): unknown {
    return path.split('.').reduce((acc: any, key) => {
      if (acc === undefined || acc === null) return undefined;
      const maybeIndex = Number(key);
      if (Number.isInteger(maybeIndex) && Array.isArray(acc)) return acc[maybeIndex];
      return acc[key];
    }, obj as any);
  }

  private safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  private extractErrorMessage(data: unknown, fallback: string): string {
    return String(
      this.readPath(data, 'error.message') ??
      this.readPath(data, 'message') ??
      fallback,
    );
  }

  private estimateCost(provider: AiProviderRuntimeConfig, totalTokens: number): number {
    const costPer1K = Number(
      provider.pricing?.costPer1KTokens ??
      provider.pricingPerUnit ??
      0,
    );
    return costPer1K > 0 ? (totalTokens / 1000) * costPer1K : 0;
  }

  private async recordPlatformUsage(
    req: UserAiRequest,
    providerKey: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number },
    latencyMs: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO user_ai_usage_events (
         tenant_id, connection_id, provider_key, operation, model_used,
         prompt_tokens, completion_tokens, total_tokens,
         latency_ms, cost_usd, success, campaign_id, creative_id
       )
       VALUES (
         $1,
         (SELECT id FROM user_ai_provider_connections WHERE tenant_id = $1 LIMIT 1),
         $2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11
       )`,
      [
        req.tenantId,
        providerKey,
        req.operation,
        req.model ?? null,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        latencyMs,
        usage.costUsd,
        req.campaignId ?? null,
        req.creativeId ?? null,
      ],
    );
  }

  private async recordProviderHealth(
    providerId: string,
    status: 'healthy' | 'down',
    latencyMs: number | null,
    error?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE ai_provider_catalog
       SET health_status = $1, last_health_check_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [status, providerId],
    ).catch(() => undefined);

    await this.db.query(
      `INSERT INTO ai_provider_health_snapshots (provider_id, status, latency_ms, error_message)
       VALUES ($1,$2,$3,$4)`,
      [providerId, status, latencyMs, error ?? null],
    ).catch(() => undefined);
  }

  private async markConnectionError(
    tenantId: string,
    providerKey: string,
    error: string,
  ): Promise<void> {
    try {
      await this.db.query(
        `UPDATE user_ai_provider_connections c
         SET last_health_error = $1, last_health_check = NOW(), updated_at = NOW()
         FROM ai_provider_catalog p
         WHERE c.provider_id = p.id
           AND c.tenant_id = $2
           AND p.provider_key = $3`,
        [error.slice(0, 500), tenantId, providerKey],
      );
    } catch {
      /* best effort */
    }
  }

  private joinUrl(base?: string | null, path?: string | null): string | null {
    if (!base) return null;
    if (!path) return base;
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }
}
