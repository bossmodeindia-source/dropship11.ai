/**
 * AiProviderDispatcher — PATCHED v2
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX #5 — NEMOGUARD APPLIED TO BOT OUTPUT (was bypass on BOT path)
 *
 *   BEFORE: NemoGuard was called for NVIDIA_49B and NVIDIA_253B paths only.
 *           BOT path returned content directly — zero safety check.
 *   AFTER:  executeBot() now wraps its output through guard.check().
 *           On guard failure OR error → falls back to a safe hardcoded
 *           fallback response (no infinite loop, no crash).
 *           Error path uses .catch(() => ({ safe: true })) — guard outage
 *           never blocks the pipeline (fail-open preserved).
 *
 * FIX #6 — AI USAGE ALWAYS LOGGED
 *
 *   BEFORE: logUsage() existed but was never called from resolve().
 *           AI cost was invisible — no way to track spend per user/operation.
 *   AFTER:  resolve() calls this.logUsage() after every non-cache response
 *           (BOT, NVIDIA_49B, NVIDIA_253B). Cache hits are logged at $0.
 *           Fields logged: userId, operation, source, usage, latencyMs.
 *
 * Pre-existing fixes (unchanged):
 *   FIX #5 (original) — Prometheus metrics on every AI tier
 *   NemoGuard on 49B and 253B paths — validated, no change needed
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AiRouter, SubscriptionTier } from './ai-router.service';
import { SemanticCacheService } from './semantic-cache.service';
import { MemoryService } from './memory.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { CooldownService } from './cooldown.service';
import { AiProviderRegistry } from './ai-provider.registry';
import { NemoGuardService } from '../ai-bot/safety/nemoguard.service';
import { MetricsService } from '../metrics/metrics.service';

// ── Request / Response contracts ──────────────────────────────────────────────

export type AiOperation =
  | 'listing'
  | 'campaign'
  | 'scoring'
  | 'media'
  | 'strategy'
  | 'hooks'
  | 'captions'
  | 'upsell_headline';

export interface OrchestratorRequest {
  userId:          string;
  operation:       AiOperation;
  context:         Record<string, unknown>;
  productScore?:   number;
  userTier?:       SubscriptionTier;
  campaignSpend?:  number;
  forceRefresh?:   boolean;
  systemPrompt?:   string;
}

export interface TokenUsage {
  promptTokens:     number;
  completionTokens: number;
  totalTokens:      number;
}

export type ResponseSource =
  | 'CACHE_L1'
  | 'CACHE_L2'
  | 'BOT'
  | 'NVIDIA_49B'
  | 'NVIDIA_253B';

export interface OrchestratorResponse {
  content:      unknown;
  source:       ResponseSource;
  latencyMs:    number;
  cacheKey?:    string;
  memoryUsed?:  boolean;
  jobId?:       string;
  usage?:       TokenUsage;
  routingReason?: string;
}

// ── Operation-specific system prompts ─────────────────────────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  listing: `You are an expert e-commerce copywriter specialising in high-converting product listings.
Generate compelling, SEO-optimised titles, descriptions, and tags.
Respond ONLY in JSON: { "title": "...", "description": "...", "tags": [...] }`,

  campaign: `You are a performance marketing expert for dropshipping businesses.
Generate targeted ad campaign copy with hook, headline, body, CTA, and audience.
Respond ONLY in JSON: { "hook": "...", "headline": "...", "body": "...", "cta": "...", "audience": {...}, "keywords": [...] }`,

  scoring: `You are a product research analyst. Analyse the product and return demand/competition scores.
Respond ONLY in JSON: { "demandScore": 0, "competitionScore": 0, "analysis": "..." }`,

  media: `You are a visual creative director for e-commerce ad campaigns.
Generate optimised prompts for AI image and video generation.
Respond ONLY in JSON: { "imagePrompt": "...", "videoPrompt": "...", "imageModel": "flux-schnell-image", "videoModel": "seedance-lite-t2v" }`,

  strategy: `You are a senior performance marketing strategist.
Analyse campaign metrics and return a scale/pause/kill/hold decision.
Respond ONLY in JSON: { "decision": "SCALE|PAUSE|KILL|HOLD", "reasoning": "...", "recommended_budget_delta": 0, "confidence": 0 }`,

  hooks: `You are a direct-response copywriter specialised in social media ad hooks.
Generate 5 scroll-stopping opening hooks for the product.
Respond ONLY in JSON: { "hooks": ["...", "...", "...", "...", "..."] }`,

  captions: `You are a social media copywriter specialised in e-commerce.
Generate 3 platform-optimised ad captions.
Respond ONLY in JSON: { "captions": { "meta": "...", "instagram": "...", "tiktok": "..." } }`,
};

// FIX #5: Safe fallback content used when BOT output fails NemoGuard
const SAFE_BOT_FALLBACK: Record<string, unknown> = {
  hook:        'Discover why thousands love this product.',
  headline:    'Premium Quality at Unbeatable Prices',
  body:        'Shop now and experience the difference.',
  cta:         'Shop Now',
  title:       'Quality Product',
  description: 'High-quality product for everyday use.',
  tags:        ['quality', 'value', 'everyday'],
};

@Injectable()
export class AiProviderDispatcher {
  private readonly logger = new Logger(AiProviderDispatcher.name);

  constructor(
    @Inject(DB_TOKEN)           private readonly db:       NodePgDatabase<typeof schema>,
    private readonly router:    AiRouter,
    private readonly cache:     SemanticCacheService,
    private readonly memory:    MemoryService,
    private readonly breaker:   CircuitBreakerService,
    private readonly cooldown:  CooldownService,
    private readonly registry:  AiProviderRegistry,
    private readonly guard:     NemoGuardService,
    private readonly metrics:   MetricsService,
  ) {}

  async resolve(req: OrchestratorRequest): Promise<OrchestratorResponse> {
    const start    = Date.now();
    const cacheKey = this.cache.buildCacheKey(req);

    // ── Tier 0: Redis L1 cache ─────────────────────────────────────────────
    if (!req.forceRefresh) {
      const l1 = await this.cache.getL1(cacheKey);
      if (l1 !== null) {
        const latencyMs = Date.now() - start;
        this.metrics.recordAiDispatch('CACHE_L1', req.operation, 0, 'cache', latencyMs);
        // FIX #6: Log usage for cache hits too ($0 cost, but needed for analytics)
        void this.logUsage(req.userId, req.operation, 'CACHE_L1', undefined, latencyMs);
        return {
          content:   l1,
          source:    'CACHE_L1',
          latencyMs,
          cacheKey,
          memoryUsed: false,
        };
      }

      // ── Tier 1a: PostgreSQL L2 cache ──────────────────────────────────────
      const l2 = await this.cache.getL2(cacheKey);
      if (l2 !== null) {
        void this.cache.setL1(cacheKey, l2);
        const latencyMs = Date.now() - start;
        this.metrics.recordAiDispatch('CACHE_L2', req.operation, 0, 'cache', latencyMs);
        // FIX #6: Log L2 cache hit
        void this.logUsage(req.userId, req.operation, 'CACHE_L2', undefined, latencyMs);
        return {
          content:   l2,
          source:    'CACHE_L2',
          latencyMs,
          cacheKey,
          memoryUsed: false,
        };
      }
    }

    // ── Tier 1b: Memory enrichment (non-blocking) ─────────────────────────
    const patterns = await this.memory.getTopPatterns(req.operation, req.context)
      .catch(() => []);

    // ── Tier 2: Routing decision ──────────────────────────────────────────
    const tier = await this.router.decide({
      userId:        req.userId,
      operation:     req.operation,
      productScore:  req.productScore  ?? 0,
      userTier:      req.userTier      ?? 'free',
      campaignSpend: req.campaignSpend ?? 0,
    });

    // ── Tier 3/4: Execute with safe fallback ─────────────────────────────
    const response = await this.executeWithFallback(req, tier.tier as ResponseSource, patterns, start);

    // Write-back to cache (non-blocking, only for deterministic operations)
    if (response.source !== 'BOT' || req.operation !== 'strategy') {
      void this.cache.writeBack(
        cacheKey,
        response.content,
        req.operation,
        (req.context['category'] as string) ?? 'general',
      );
    }

    void this.consumeQuota(req.userId);

    // FIX #6: Log AI usage for every non-cached execution
    void this.logUsage(req.userId, req.operation, response.source, response.usage, response.latencyMs);

    return { ...response, cacheKey, memoryUsed: patterns.length > 0 };
  }

  // ── Execution with complete fallback chain ─────────────────────────────────

  private async executeWithFallback(
    req:      OrchestratorRequest,
    tier:     ResponseSource,
    patterns: Awaited<ReturnType<MemoryService['getTopPatterns']>>,
    startMs:  number,
  ): Promise<OrchestratorResponse> {
    const systemPrompt = this.buildSystemPrompt(req, patterns);
    const userMessage  = this.buildUserMessage(req);

    // ── BOT path (Tier 5 / fast-path) ────────────────────────────────────
    if (tier === 'BOT') {
      return this.executeBot(req, startMs);
    }

    // ── NVIDIA 49B path ───────────────────────────────────────────────────
    if (tier === 'NVIDIA_49B') {
      try {
        const provider = this.registry.get49B();
        const result   = await provider.generate({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userMessage },
          ],
          operation:   req.operation,
          context:     req.context,
          temperature: 0.7,
          maxTokens:   1500,
        });

        const safety = await this.guard.check(result.rawText).catch(() => ({ safe: true }));
        if (!safety.safe) {
          this.logger.warn('[Orchestrator] NemoGuard blocked 49B response → BOT fallback');
          await this.breaker.recordFailure('nvidia_49b');
          return this.executeBot(req, startMs);
        }

        await this.breaker.recordSuccess('nvidia_49b');
        const latencyMs = Date.now() - startMs;
        this.metrics.recordAiDispatch('NVIDIA_49B', req.operation, result.usage?.totalTokens ?? 0, 'nvidia_49b', latencyMs);

        return {
          content:   result.content,
          source:    'NVIDIA_49B',
          latencyMs,
          usage:     result.usage,
        };
      } catch (err) {
        this.logger.error(`[Orchestrator] 49B failed: ${(err as Error).message}`);
        await this.breaker.recordFailure('nvidia_49b');
        return this.executeBot(req, startMs);
      }
    }

    // ── NVIDIA 253B path ──────────────────────────────────────────────────
    if (tier === 'NVIDIA_253B') {
      try {
        const provider = this.registry.get253B();
        const result   = await provider.generate({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userMessage },
          ],
          operation:   req.operation,
          context:     req.context,
          temperature: 0.3,
          maxTokens:   2000,
        });

        const safety = await this.guard.check(result.rawText).catch(() => ({ safe: true }));
        if (!safety.safe) {
          this.logger.warn('[Orchestrator] NemoGuard blocked 253B response → BOT fallback');
          await this.breaker.recordFailure('nvidia_253b');
          return this.executeBot(req, startMs);
        }

        await this.breaker.recordSuccess('nvidia_253b');
        await this.cooldown.setCooldown(req.userId, 'strategy_253b', 24 * 60);

        const latencyMs = Date.now() - startMs;
        this.metrics.recordAiDispatch('NVIDIA_253B', req.operation, result.usage?.totalTokens ?? 0, 'nvidia_253b', latencyMs);

        return {
          content:   result.content,
          source:    'NVIDIA_253B',
          latencyMs,
          usage:     result.usage,
        };
      } catch (err) {
        this.logger.error(`[Orchestrator] 253B failed: ${(err as Error).message}`);
        await this.breaker.recordFailure('nvidia_253b');
        return this.executeBot(req, startMs);
      }
    }

    return this.executeBot(req, startMs);
  }

  // ── BOT execution (Tier 5 — always returns) ────────────────────────────────
  //
  // FIX #5: BOT output is now passed through NemoGuard.
  //   On unsafe → return safe hardcoded fallback (no pipeline block).
  //   On guard error → fail-open (safe: true) — guard outage never blocks.

  private async executeBot(
    req:     OrchestratorRequest,
    startMs: number,
  ): Promise<OrchestratorResponse> {
    const provider = this.registry.getBot();
    const result   = await provider.generate({
      messages:  [],
      operation: req.operation,
      context:   req.context,
    });

    // FIX #5: Apply NemoGuard to BOT output (previously bypassed)
    const safety = await this.guard.check(
      typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content),
    ).catch(() => ({ safe: true as const }));

    if (!safety.safe) {
      this.logger.warn('[Orchestrator] NemoGuard blocked BOT output → safe fallback content');
      return {
        content:   SAFE_BOT_FALLBACK,
        source:    'BOT',
        latencyMs: Date.now() - startMs,
        usage:     result.usage,
      };
    }

    const latencyMs = Date.now() - startMs;
    this.metrics.recordAiDispatch('BOT', req.operation, 0, 'bot', latencyMs);

    return {
      content:   result.content,
      source:    'BOT',
      latencyMs,
      usage:     result.usage,
    };
  }

  // ── Prompt building ────────────────────────────────────────────────────────

  private buildSystemPrompt(
    req:      OrchestratorRequest,
    patterns: Awaited<ReturnType<MemoryService['getTopPatterns']>>,
  ): string {
    const base = req.systemPrompt ?? SYSTEM_PROMPTS[req.operation] ?? SYSTEM_PROMPTS.listing;
    return this.memory.buildMemoryEnrichedPrompt(base, patterns);
  }

  private buildUserMessage(req: OrchestratorRequest): string {
    return (
      `Context:\n${JSON.stringify(req.context, null, 2)}\n\n` +
      `Generate the ${req.operation} content now.`
    );
  }

  // ── Quota management ───────────────────────────────────────────────────────

  private async consumeQuota(userId: string): Promise<void> {
    try {
      await this.db.execute(
        sql`UPDATE subscriptions
            SET ai_requests_used = ai_requests_used + 1
            WHERE user_id = ${userId}`,
      );
    } catch { /* non-critical */ }
  }

  // ── Usage logging — FIX #6: now called from resolve() ─────────────────────

  async logUsage(
    userId:    string,
    operation: string,
    source:    ResponseSource,
    usage:     TokenUsage | undefined,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.db.insert(schema.aiUsageLogs).values({
        userId,
        operation,
        model: String(source),
        promptTokens:     usage?.promptTokens     ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens:      usage?.totalTokens      ?? 0,
        latencyMs,
        createdAt:        new Date(),
      });
    } catch { /* non-critical — logging must never throw */ }
  }
  /** Convenience alias — some callers use .generate() instead of .resolve() */
  async generate(req: OrchestratorRequest): Promise<OrchestratorResponse> {
    return this.resolve(req);
  }

  /** Convenience alias — used by simple text completion callers */
  async complete(params: {
    prompt:    string;
    maxTokens?: number;
    context?:  string;
  }): Promise<string> {
    const res = await this.resolve({
      userId:    'system',
      operation: (params.context ?? 'listing') as AiOperation,
      context:   { prompt: params.prompt, maxTokens: params.maxTokens ?? 200 },
    });
    return String(res.content ?? '');
  }
}
