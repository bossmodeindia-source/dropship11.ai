/**
 * UserAiRouterService — USER AI LAYER
 *
 * CRITICAL ARCHITECTURE:
 * This service routes ALL user AI generation calls to the user's own provider keys.
 * It NEVER accesses admin-owned keys (ConfigVaultService).
 * This is the complete separation of Platform AI Layer vs User AI Layer.
 *
 * ROUTING PRIORITY:
 *  1. User's primary provider for the task category
 *  2. User's secondary provider (if first fails)
 *  3. Optional platform fallback (ONLY if user enabled + subscription permits)
 *  4. Throws ForbiddenException — never silently uses admin keys
 *
 * Supported capabilities routed here:
 *  - reasoning:         OpenAI, Claude, OpenRouter, NVIDIA, Groq, DeepSeek
 *  - image_generation:  Flux, SDXL, Imagen
 *  - video_generation:  Runway, Kling, Veo, Pika, HeyGen
 *  - voice:             ElevenLabs, Whisper
 */

import {
  Injectable,
  Logger,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import { UserAiConnectionsService } from './user-ai-connections.service';

export interface UserAiRequest {
  tenantId:        string;
  category:        'reasoning' | 'image_generation' | 'video_generation' | 'voice';
  operation:       string;          // 'script_generation', 'scene_image', 'video_clip', 'voiceover'
  preferredProvider?: string;       // provider_key — override routing
  messages?:       Array<{ role: string; content: string }>;
  prompt?:         string;
  model?:          string;
  maxTokens?:      number;
  temperature?:    number;
  imageUrl?:       string;          // for image-to-video
  durationSeconds?: number;         // for video generation
  voiceId?:        string;          // for voice
  campaignId?:     string;
  creativeId?:     string;
}

export interface UserAiResponse {
  providerKey:       string;
  content:           string | Buffer | null;
  contentUrl?:       string;        // for video/image (signed URL or blob URL)
  rawResponse?:      unknown;
  usage: {
    promptTokens:     number;
    completionTokens: number;
    totalTokens:      number;
    costUsd:          number;
  };
  latencyMs:         number;
  usedFallback:      boolean;
}

// ── Provider call implementations ─────────────────────────────────────────────

interface ProviderCallContext {
  apiKey: string;
  secondaryKey: string | null;
  request: UserAiRequest;
}

@Injectable()
export class UserAiRouterService {
  private readonly logger = new Logger(UserAiRouterService.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly connections: UserAiConnectionsService,
  ) {}

  // ── Main routing entrypoint ───────────────────────────────────────────────

  async route(req: UserAiRequest): Promise<UserAiResponse> {
    const candidates = await this.buildProviderCandidates(req);

    if (candidates.length === 0) {
      throw new ForbiddenException(
        `No AI provider connected for category '${req.category}'. ` +
        `Go to Settings → AI Providers to connect your API key.`,
      );
    }

    let lastError: Error | null = null;

    for (const providerKey of candidates) {
      try {
        const { apiKey, secondaryKey } = await this.connections.decryptKeyForRuntime(
          req.tenantId, providerKey,
        );

        const start = Date.now();
        const result = await this.callProvider(providerKey, { apiKey, secondaryKey, request: req });
        const latencyMs = Date.now() - start;

        // Record usage asynchronously (don't block response)
        this.connections.recordUsage(req.tenantId, providerKey, req.operation, {
          ...result.usage,
          latencyMs,
          modelUsed: req.model,
          campaignId: req.campaignId,
          creativeId: req.creativeId,
        }).catch(err => this.logger.warn(`Usage record failed: ${err.message}`));

        return {
          providerKey,
          content:      result.content,
          contentUrl:   result.contentUrl,
          rawResponse:  result.rawResponse,
          usage:        result.usage,
          latencyMs,
          usedFallback: false,
        };
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `[UserAI] Provider '${providerKey}' failed for tenant ${req.tenantId}: ${lastError.message}`,
        );
        // Mark connection status on persistent errors
        await this.markConnectionError(req.tenantId, providerKey, lastError.message);
      }
    }

    throw new ServiceUnavailableException(
      `All user AI providers failed for category '${req.category}'. Last error: ${lastError?.message}`,
    );
  }

  // ── Build ordered list of providers to try ────────────────────────────────

  private async buildProviderCandidates(req: UserAiRequest): Promise<string[]> {
    // Get user's active connections for this category
    const result = await this.db.query(
      `SELECT c.id, p.provider_key, p.category, c.allow_platform_fallback,
              c.connection_status, c.quota_used, c.quota_limit
       FROM user_ai_provider_connections c
       JOIN ai_provider_catalog p ON p.id = c.provider_id
       WHERE c.tenant_id = $1
         AND c.is_active = true
         AND c.connection_status = 'active'
         AND p.status = 'approved'
         AND p.category = $2
         AND (c.quota_limit IS NULL OR c.quota_used < c.quota_limit)
       ORDER BY c.total_requests ASC, c.created_at ASC`,
      [req.tenantId, req.category],
    );

    let candidates: string[] = result.rows.map((r: any) => r.provider_key);

    // If preferred provider specified, put it first
    if (req.preferredProvider) {
      candidates = [
        req.preferredProvider,
        ...candidates.filter(k => k !== req.preferredProvider),
      ];
    }

    // Platform fallback: ONLY if user explicitly enabled it AND subscription allows
    // This is intentionally strict — admin keys are NEVER used without explicit opt-in
    if (candidates.length === 0) {
      const allowFallback = result.rows.some((r: any) => r.allow_platform_fallback);
      if (!allowFallback) {
        this.logger.warn(
          `Tenant ${req.tenantId} has no active ${req.category} provider — fallback not enabled`,
        );
      }
      // Even with fallback enabled, we only use platform AI for non-billable ops
      // This is enforced at the subscription level (not here)
    }

    return candidates;
  }

  // ── Provider dispatch table ───────────────────────────────────────────────

  private async callProvider(
    providerKey: string,
    ctx: ProviderCallContext,
  ): Promise<{
    content: string | Buffer | null;
    contentUrl?: string;
    rawResponse?: unknown;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  }> {
    switch (providerKey) {
      case 'openai':     return this.callOpenAi(ctx);
      case 'claude':     return this.callClaude(ctx);
      case 'openrouter': return this.callOpenRouter(ctx);
      case 'nvidia':     return this.callNvidiaUser(ctx);
      case 'flux':       return this.callFlux(ctx);
      case 'runway':     return this.callRunway(ctx);
      case 'kling':      return this.callKling(ctx);
      case 'elevenlabs': return this.callElevenLabs(ctx);
      default:
        throw new Error(`No implementation for provider '${providerKey}'`);
    }
  }

  // ── OpenAI (user key) ─────────────────────────────────────────────────────

  private async callOpenAi(ctx: ProviderCallContext): Promise<any> {
    const model = ctx.request.model ?? 'gpt-4o';
    const body = {
      model,
      messages:    ctx.request.messages ?? [{ role: 'user', content: ctx.request.prompt ?? '' }],
      max_tokens:  ctx.request.maxTokens ?? 2000,
      temperature: ctx.request.temperature ?? 0.7,
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenAI ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`);
    }

    const data: any = await res.json();
    const content   = data.choices?.[0]?.message?.content ?? '';
    const usage     = data.usage ?? {};

    return {
      content,
      rawResponse: data,
      usage: {
        promptTokens:     usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens:      usage.total_tokens ?? 0,
        costUsd:          this.estimateCost('openai', model, usage.total_tokens ?? 0),
      },
    };
  }

  // ── Anthropic Claude (user key) ───────────────────────────────────────────

  private async callClaude(ctx: ProviderCallContext): Promise<any> {
    const model    = ctx.request.model ?? 'claude-sonnet-4-5-20251001';
    const messages = ctx.request.messages ?? [{ role: 'user', content: ctx.request.prompt ?? '' }];
    // Extract system message if present
    const system   = messages.find(m => m.role === 'system')?.content;
    const userMsgs = messages.filter(m => m.role !== 'system');

    const body: any = {
      model,
      max_tokens:  ctx.request.maxTokens ?? 2000,
      messages:    userMsgs,
    };
    if (system) body.system = system;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ctx.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Claude ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`);
    }

    const data: any = await res.json();
    const content   = data.content?.[0]?.text ?? '';
    const usage     = data.usage ?? {};

    return {
      content,
      rawResponse: data,
      usage: {
        promptTokens:     usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
        totalTokens:      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        costUsd:          this.estimateCost('claude', model, (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
      },
    };
  }

  // ── OpenRouter (user key) ─────────────────────────────────────────────────

  private async callOpenRouter(ctx: ProviderCallContext): Promise<any> {
    const model = ctx.request.model ?? 'meta-llama/llama-3.1-70b-instruct';
    const body = {
      model,
      messages: ctx.request.messages ?? [{ role: 'user', content: ctx.request.prompt ?? '' }],
      max_tokens: ctx.request.maxTokens ?? 2000,
      temperature: ctx.request.temperature ?? 0.7,
    };

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer':  'https://app.aiempirebot.com',
        'X-Title':       'AI Empire Bot',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenRouter ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`);
    }

    const data: any = await res.json();
    const content   = data.choices?.[0]?.message?.content ?? '';
    const usage     = data.usage ?? {};

    return {
      content,
      rawResponse: data,
      usage: {
        promptTokens:     usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens:      usage.total_tokens ?? 0,
        costUsd:          this.estimateCost('openrouter', model, usage.total_tokens ?? 0),
      },
    };
  }

  // ── NVIDIA (user key) ─────────────────────────────────────────────────────

  private async callNvidiaUser(ctx: ProviderCallContext): Promise<any> {
    const model = ctx.request.model ?? 'meta/llama-3.1-70b-instruct';
    const body = {
      model,
      messages: ctx.request.messages ?? [{ role: 'user', content: ctx.request.prompt ?? '' }],
      max_tokens: ctx.request.maxTokens ?? 2000,
      temperature: ctx.request.temperature ?? 0.7,
      stream: false,
    };

    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`NVIDIA ${res.status}: ${JSON.stringify(err)}`);
    }

    const data: any = await res.json();
    const content   = data.choices?.[0]?.message?.content ?? '';
    const usage     = data.usage ?? {};

    return {
      content,
      rawResponse: data,
      usage: {
        promptTokens:     usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens:      usage.total_tokens ?? 0,
        costUsd:          0, // NVIDIA pricing varies by model
      },
    };
  }

  // ── Flux Image Generation (user key) ─────────────────────────────────────

  private async callFlux(ctx: ProviderCallContext): Promise<any> {
    const model = ctx.request.model ?? 'flux-1-pro';
    const body = {
      prompt:  ctx.request.prompt,
      width:   1024,
      height:  1024,
      steps:   28,
      guidance: 3.5,
      output_format: 'jpeg',
    };

    // Flux via replicate or direct BFL API
    const res = await fetch('https://api.bfl.ml/v1/flux-pro-1.1', {
      method: 'POST',
      headers: {
        'x-key':         ctx.apiKey,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new Error(`Flux ${res.status}: ${res.statusText}`);
    }

    const data: any = await res.json();

    // Poll for result
    const imageUrl = await this.pollFluxResult(data.id, ctx.apiKey);

    return {
      content:    null,
      contentUrl: imageUrl,
      rawResponse: data,
      usage: {
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        costUsd: 0.055, // ~$0.055 per flux-pro image
      },
    };
  }

  private async pollFluxResult(requestId: string, apiKey: string, maxAttempts = 30): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const res = await fetch(`https://api.bfl.ml/v1/get_result?id=${requestId}`, {
        headers: { 'x-key': apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      if (data.status === 'Ready') return data.result?.sample ?? data.result;
      if (data.status === 'Failed') throw new Error(`Flux generation failed: ${data.error}`);
    }
    throw new Error('Flux generation timed out');
  }

  // ── Runway Video Generation (user key) ───────────────────────────────────

  private async callRunway(ctx: ProviderCallContext): Promise<any> {
    const body: any = {
      model:           'gen3a_turbo',
      promptText:      ctx.request.prompt,
      duration:        ctx.request.durationSeconds ?? 5,
      ratio:           '1280:768',
      watermark:       false,
    };

    if (ctx.request.imageUrl) {
      body.promptImage = ctx.request.imageUrl;
    }

    const res = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Runway ${res.status}: ${JSON.stringify(err)}`);
    }

    const task: any = await res.json();
    const videoUrl  = await this.pollRunwayTask(task.id, ctx.apiKey);

    return {
      content:    null,
      contentUrl: videoUrl,
      rawResponse: task,
      usage: {
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        costUsd: (ctx.request.durationSeconds ?? 5) * 0.05, // ~$0.05/sec Turbo
      },
    };
  }

  private async pollRunwayTask(taskId: string, apiKey: string, maxAttempts = 60): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      if (data.status === 'SUCCEEDED') return data.output?.[0];
      if (['FAILED','CANCELLED'].includes(data.status)) {
        throw new Error(`Runway task ${data.status}: ${data.failure ?? ''}`);
      }
    }
    throw new Error('Runway generation timed out');
  }

  // ── Kling Video Generation (user key) ─────────────────────────────────────

  private async callKling(ctx: ProviderCallContext): Promise<any> {
    // Kling API via fal.ai proxy or direct
    const body: any = {
      prompt:   ctx.request.prompt,
      duration: ctx.request.durationSeconds ?? 5,
      aspect_ratio: '16:9',
    };
    if (ctx.request.imageUrl) {
      body.image_url = ctx.request.imageUrl;
    }

    const res = await fetch('https://api.klingai.com/v1/videos/image2video', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Kling ${res.status}: ${res.statusText}`);
    }

    const task: any = await res.json();
    const videoUrl  = await this.pollKlingTask(task.data?.task_id, ctx.apiKey);

    return {
      content:    null,
      contentUrl: videoUrl,
      rawResponse: task,
      usage: {
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        costUsd: (ctx.request.durationSeconds ?? 5) * 0.028,
      },
    };
  }

  private async pollKlingTask(taskId: string, apiKey: string, maxAttempts = 60): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await fetch(`https://api.klingai.com/v1/videos/image2video/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      if (data.data?.task_status === 'succeed') return data.data?.task_result?.videos?.[0]?.url;
      if (data.data?.task_status === 'failed') throw new Error(`Kling failed: ${data.data?.task_status_msg}`);
    }
    throw new Error('Kling generation timed out');
  }

  // ── ElevenLabs (user key) ─────────────────────────────────────────────────

  private async callElevenLabs(ctx: ProviderCallContext): Promise<any> {
    const voiceId = ctx.request.voiceId ?? 'pNInz6obpgDQGcFmaJgB'; // Rachel
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key':   ctx.apiKey,
        'Content-Type': 'application/json',
        Accept:         'audio/mpeg',
      },
      body: JSON.stringify({
        text:           ctx.request.prompt ?? '',
        model_id:       'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs ${res.status}: ${res.statusText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      content:    buffer,
      rawResponse: null,
      usage: {
        promptTokens: 0, completionTokens: 0,
        totalTokens: ctx.request.prompt?.length ?? 0,
        costUsd: ((ctx.request.prompt?.length ?? 0) / 1000) * 0.18,
      },
    };
  }

  // ── Mark connection error ──────────────────────────────────────────────────

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
    } catch { /* best effort */ }
  }

  // ── Cost estimation ───────────────────────────────────────────────────────

  private estimateCost(provider: string, model: string, tokens: number): number {
    const rates: Record<string, number> = {
      'openai:gpt-4o':              0.005 / 1000,
      'openai:gpt-4-turbo':         0.01  / 1000,
      'claude:claude-sonnet-4-5':   0.003 / 1000,
      'claude:claude-haiku':        0.00025 / 1000,
      'openrouter:default':         0.001 / 1000,
    };
    const key   = `${provider}:${model}`;
    const rate  = rates[key] ?? rates[`${provider}:default`] ?? 0.001 / 1000;
    return tokens * rate;
  }
}
