/**
 * ai-provider-resilience.service.ts — V65 AI PROVIDER HARDENING
 *
 * Augments the existing CircuitBreakerService with:
 *
 *  1. FALLBACK CHAINS — ordered provider list per operation category
 *     If primary fails → secondary → tertiary → degraded response
 *     No provider failure may crash a workflow.
 *
 *  2. DEGRADED MODE — when all providers in a chain are open
 *     Returns a safe, pre-canned response instead of throwing.
 *     Workflows continue (with reduced quality) rather than failing.
 *
 *  3. RETRY POLICY — per-provider retry configuration
 *     Different timeouts for different provider types.
 *
 *  4. QUOTA TRACKING — per-tenant, per-provider daily quota
 *     Prevents one tenant from exhausting a shared provider key.
 *
 *  5. PROVIDER HEALTH DASHBOARD — real-time health for admin
 *
 * Usage:
 *   const result = await resilience.executeWithFallback('reasoning', tenantId, async (provider) => {
 *     return callProvider(provider, prompt);
 *   });
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { REDIS_CLIENT }               from '../common/redis/redis.module';
import type Redis                     from 'ioredis';

// Provider identifiers — canonical list
export type AiProvider =
  | 'openai'
  | 'anthropic'
  | 'nvidia_49b'
  | 'nvidia_253b'
  | 'groq'
  | 'deepseek'
  | 'openrouter'
  | 'flux'
  | 'runway'
  | 'elevenlabs';

// Operation categories with fallback chains
export type AiOperationCategory =
  | 'reasoning'         // text generation, analysis
  | 'image_generation'  // product images, ad creatives
  | 'video_generation'  // ad videos, reels
  | 'voice'             // voiceovers, TTS
  | 'fast_completion';  // quick operations (scoring, classification)

// Fallback chains per operation category
const FALLBACK_CHAINS: Record<AiOperationCategory, AiProvider[]> = {
  reasoning:        ['openai', 'anthropic', 'groq', 'deepseek', 'nvidia_49b'],
  image_generation: ['flux', 'nvidia_49b'],
  video_generation: ['runway'],
  voice:            ['elevenlabs'],
  fast_completion:  ['groq', 'nvidia_49b', 'openai', 'deepseek'],
};

// Degraded mode responses — used when ALL providers in chain are down
const DEGRADED_RESPONSES: Record<AiOperationCategory, string> = {
  reasoning:        '{"degraded":true,"message":"AI generation temporarily unavailable. Please retry in a few minutes."}',
  image_generation: 'DEGRADED_IMAGE_PLACEHOLDER',
  video_generation: 'DEGRADED_VIDEO_PLACEHOLDER',
  voice:            'DEGRADED_VOICE_PLACEHOLDER',
  fast_completion:  '{"score":0.5,"degraded":true}',
};

// Per-provider retry and timeout config
const PROVIDER_CONFIG: Record<AiProvider, { maxRetries: number; timeoutMs: number }> = {
  openai:       { maxRetries: 2, timeoutMs: 30_000 },
  anthropic:    { maxRetries: 2, timeoutMs: 60_000 },
  nvidia_49b:   { maxRetries: 1, timeoutMs: 45_000 },
  nvidia_253b:  { maxRetries: 1, timeoutMs: 90_000 },
  groq:         { maxRetries: 3, timeoutMs: 15_000 }, // fast, allow more retries
  deepseek:     { maxRetries: 2, timeoutMs: 30_000 },
  openrouter:   { maxRetries: 2, timeoutMs: 30_000 },
  flux:         { maxRetries: 1, timeoutMs: 60_000 },
  runway:       { maxRetries: 1, timeoutMs: 120_000 },
  elevenlabs:   { maxRetries: 2, timeoutMs: 30_000 },
};

// Circuit breaker thresholds
const FAILURE_THRESHOLD  = 3;
const FAILURE_WINDOW_S   = 60;
const OPEN_TTL_S         = 120;

// Daily quota per tenant per provider (in tokens, approximate)
const DEFAULT_DAILY_QUOTA_TOKENS = 500_000;

export interface ProviderCallResult<T> {
  result:        T;
  provider:      AiProvider;
  usedFallback:  boolean;
  degraded:      boolean;
  attempts:      number;
  latencyMs:     number;
}

@Injectable()
export class AiProviderResilienceService {
  private readonly logger = new Logger(AiProviderResilienceService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── Main entry point: execute with fallback chain ─────────────────────────

  async executeWithFallback<T>(
    category:   AiOperationCategory,
    tenantId:   string,
    fn:         (provider: AiProvider) => Promise<T>,
    options?: { skipQuotaCheck?: boolean },
  ): Promise<ProviderCallResult<T>> {
    const chain    = FALLBACK_CHAINS[category];
    const start    = Date.now();
    let   attempts = 0;
    let   lastError: Error | null = null;

    for (const provider of chain) {
      attempts++;

      // Check circuit breaker
      if (await this.isCircuitOpen(provider)) {
        this.logger.debug(`[Resilience] ${provider} circuit OPEN — skipping`);
        continue;
      }

      // Check tenant quota
      if (!options?.skipQuotaCheck && await this.isQuotaExhausted(tenantId, provider)) {
        this.logger.warn(`[Resilience] ${provider} quota exhausted for tenant ${tenantId}`);
        continue;
      }

      // Execute with retry
      const config = PROVIDER_CONFIG[provider];
      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
          const result = await this.withTimeout(fn(provider), config.timeoutMs, provider);
          await this.recordSuccess(provider);

          this.logger.debug(
            `[Resilience] ${category} via ${provider} (attempt ${attempt}/${config.maxRetries}) ` +
            `in ${Date.now() - start}ms`,
          );

          return {
            result,
            provider,
            usedFallback: provider !== chain[0],
            degraded:     false,
            attempts,
            latencyMs:    Date.now() - start,
          };
        } catch (err) {
          lastError = err as Error;
          this.logger.warn(
            `[Resilience] ${provider} attempt ${attempt}/${config.maxRetries} failed: ${lastError.message}`,
          );

          if (attempt === config.maxRetries) {
            await this.recordFailure(provider);
          } else {
            // Brief pause before retry
            await this.sleep(500 * attempt);
          }
        }
      }
    }

    // All providers exhausted — enter degraded mode
    this.logger.error(
      `[Resilience] All providers for ${category} failed after ${attempts} attempts. ` +
      `Last error: ${lastError?.message}. Returning degraded response.`,
    );

    const degradedResult = DEGRADED_RESPONSES[category] as unknown as T;
    return {
      result:       degradedResult,
      provider:     chain[0],
      usedFallback: true,
      degraded:     true,
      attempts,
      latencyMs:    Date.now() - start,
    };
  }

  // ── Circuit breaker ───────────────────────────────────────────────────────

  async isCircuitOpen(provider: AiProvider): Promise<boolean> {
    try {
      const state = await this.redis.get(`ai:cb:${provider}:state`);
      if (state === 'open') return true;
      const failures = parseInt(await this.redis.get(`ai:cb:${provider}:failures`) ?? '0', 10);
      return failures >= FAILURE_THRESHOLD;
    } catch {
      return false; // Redis down → fail open (don't block traffic)
    }
  }

  async recordSuccess(provider: AiProvider): Promise<void> {
    try {
      await this.redis.del(`ai:cb:${provider}:failures`, `ai:cb:${provider}:state`);
    } catch { /* silent */ }
  }

  async recordFailure(provider: AiProvider): Promise<void> {
    try {
      const failures = await this.redis.incr(`ai:cb:${provider}:failures`);
      await this.redis.expire(`ai:cb:${provider}:failures`, FAILURE_WINDOW_S);
      if (failures >= FAILURE_THRESHOLD) {
        await this.redis.set(`ai:cb:${provider}:state`, 'open', 'EX', OPEN_TTL_S);
        this.logger.warn(`[CircuitBreaker] ${provider} OPENED (${failures} failures)`);
      }
    } catch { /* silent */ }
  }

  // ── Quota tracking ────────────────────────────────────────────────────────

  async trackTokenUsage(
    tenantId: string,
    provider: AiProvider,
    tokens:   number,
  ): Promise<void> {
    const key = `ai:quota:${tenantId}:${provider}:${this.todayKey()}`;
    try {
      await this.redis.incrby(key, tokens);
      await this.redis.expire(key, 86_400); // 24h TTL
    } catch { /* silent */ }
  }

  async isQuotaExhausted(tenantId: string, provider: AiProvider): Promise<boolean> {
    const key = `ai:quota:${tenantId}:${provider}:${this.todayKey()}`;
    try {
      const used = parseInt(await this.redis.get(key) ?? '0', 10);
      return used >= DEFAULT_DAILY_QUOTA_TOKENS;
    } catch {
      return false;
    }
  }

  async getQuotaUsage(tenantId: string): Promise<Record<AiProvider, number>> {
    const providers: AiProvider[] = [
      'openai', 'anthropic', 'nvidia_49b', 'groq', 'deepseek', 'flux', 'runway', 'elevenlabs',
    ];
    const today = this.todayKey();
    const usage: Record<string, number> = {};

    await Promise.all(providers.map(async (p) => {
      try {
        const val = await this.redis.get(`ai:quota:${tenantId}:${p}:${today}`);
        usage[p] = parseInt(val ?? '0', 10);
      } catch {
        usage[p] = 0;
      }
    }));

    return usage as Record<AiProvider, number>;
  }

  // ── Provider health dashboard ─────────────────────────────────────────────

  async getHealthDashboard(): Promise<Record<AiProvider, {
    circuitState: 'closed' | 'open';
    failures:     number;
    openUntil?:   string;
  }>> {
    const providers: AiProvider[] = [
      'openai', 'anthropic', 'nvidia_49b', 'nvidia_253b',
      'groq', 'deepseek', 'flux', 'runway', 'elevenlabs',
    ];
    const dashboard: Record<string, any> = {};

    await Promise.all(providers.map(async (p) => {
      try {
        const [state, failures, ttl] = await Promise.all([
          this.redis.get(`ai:cb:${p}:state`),
          this.redis.get(`ai:cb:${p}:failures`),
          this.redis.ttl(`ai:cb:${p}:state`),
        ]);
        dashboard[p] = {
          circuitState: state === 'open' ? 'open' : 'closed',
          failures:     parseInt(failures ?? '0', 10),
          openUntil:    state === 'open' && ttl > 0
            ? new Date(Date.now() + ttl * 1000).toISOString()
            : undefined,
        };
      } catch {
        dashboard[p] = { circuitState: 'closed', failures: 0 };
      }
    }));

    return dashboard as any;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private withTimeout<T>(promise: Promise<T>, ms: number, provider: AiProvider): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${provider} timeout after ${ms}ms`)), ms),
      ),
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }
}
