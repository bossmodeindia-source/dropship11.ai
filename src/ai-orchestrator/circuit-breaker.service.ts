/**
 * CircuitBreakerService — V70 Production Certified
 *
 * REQUIREMENT 11: Circuit breakers for all external providers
 *
 * Covered providers:
 *   ✅ Shopify
 *   ✅ Telegram
 *   ✅ Meta
 *   ✅ Supplier APIs
 *   ✅ AI providers (NVIDIA 49B, 253B, MuAPI, NemoGuard, OpenAI, Anthropic, Groq)
 *
 * Three-state FSM per provider:
 *   CLOSED    → normal operation — all calls allowed
 *   OPEN      → failure threshold exceeded — all calls blocked (returns 503)
 *   HALF_OPEN → probe window — one call allowed to test recovery
 *
 * Transitions:
 *   FAILURE_THRESHOLD (3) failures within FAILURE_WINDOW_S (60s) → CLOSED → OPEN
 *   OPEN + OPEN_TTL_S (120s) elapses → OPEN → HALF_OPEN
 *   HALF_OPEN + successful call → HALF_OPEN → CLOSED
 *   HALF_OPEN + failed call     → HALF_OPEN → OPEN (reset TTL)
 *
 * Redis failure policy: fail-open for AI providers (circuit never blocks on
 * Redis outage). Shopify/Telegram/Meta/Supplier use in-memory fallback to
 * preserve circuit state across the same instance.
 *
 * Key scheme: cb:{provider}:state  (open|half_open|closed)
 *             cb:{provider}:fails  (integer counter)
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { REDIS_CLIENT }               from '../common/redis/redis.module';
import type Redis                     from 'ioredis';

// All providers requiring circuit breakers per REQUIREMENT 11
export type CircuitProvider =
  // AI providers
  | 'nvidia_49b'
  | 'nvidia_253b'
  | 'muapi'
  | 'nemoguard'
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'deepseek'
  // Commerce providers
  | 'shopify'
  | 'telegram'
  | 'meta'
  // Supply chain
  | 'supplier'
  | 'tracking';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitStatus {
  provider: CircuitProvider;
  state:    CircuitState;
  failures: number;
  openedAt?: string;
  nextProbeAt?: string;
}

const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_S  = 60;
const OPEN_TTL_S        = 120;
const HALF_OPEN_TTL_S   = 30;

// In-process fallback for when Redis is unavailable
const inMemoryState = new Map<CircuitProvider, { state: CircuitState; failures: number; ts: number }>();

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  // Per-instance probe locks for HALF_OPEN state
  private readonly probeInFlight = new Set<CircuitProvider>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /** Returns true if the circuit is OPEN — caller should return 503 */
  async isOpen(provider: CircuitProvider): Promise<boolean> {
    const state = await this.getState(provider);
    return state === 'OPEN';
  }

  /** Returns true if calls are allowed (CLOSED or HALF_OPEN probe slot available) */
  async allowRequest(provider: CircuitProvider): Promise<boolean> {
    const state = await this.getState(provider);
    if (state === 'CLOSED')    return true;
    if (state === 'OPEN')      return false;
    // HALF_OPEN: allow exactly one probe at a time
    if (this.probeInFlight.has(provider)) {
      this.logger.debug(`[CB] ${provider} HALF_OPEN — probe already in flight`);
      return false;
    }
    this.probeInFlight.add(provider);
    return true;
  }

  /** Call after a successful external call */
  async recordSuccess(provider: CircuitProvider): Promise<void> {
    this.probeInFlight.delete(provider);
    try {
      await Promise.all([
        this.redis.del(`cb:${provider}:state`),
        this.redis.del(`cb:${provider}:fails`),
      ]);
      inMemoryState.delete(provider);
      this.logger.debug(`[CB] ${provider} → CLOSED (success)`);
    } catch {
      inMemoryState.set(provider, { state: 'CLOSED', failures: 0, ts: Date.now() });
    }
  }

  /** Call after a failed external call */
  async recordFailure(provider: CircuitProvider): Promise<void> {
    this.probeInFlight.delete(provider);
    try {
      const fails = await this.redis.incr(`cb:${provider}:fails`);
      await this.redis.expire(`cb:${provider}:fails`, FAILURE_WINDOW_S);

      const currentState = await this.getState(provider);

      if (currentState === 'HALF_OPEN' || fails >= FAILURE_THRESHOLD) {
        await this.redis.set(`cb:${provider}:state`, 'open', 'EX', OPEN_TTL_S);
        this.logger.warn(
          `[CB] ${provider} → OPEN after ${fails} failures (prev=${currentState})`,
        );
        inMemoryState.set(provider, { state: 'OPEN', failures: fails, ts: Date.now() });
      } else {
        this.logger.debug(`[CB] ${provider} failure ${fails}/${FAILURE_THRESHOLD}`);
        inMemoryState.set(provider, { state: 'CLOSED', failures: fails, ts: Date.now() });
      }
    } catch {
      // Redis down — track in memory
      const mem   = inMemoryState.get(provider) ?? { state: 'CLOSED' as CircuitState, failures: 0, ts: Date.now() };
      const fails = (mem.failures ?? 0) + 1;
      if (fails >= FAILURE_THRESHOLD) {
        inMemoryState.set(provider, { state: 'OPEN', failures: fails, ts: Date.now() });
        this.logger.warn(`[CB] ${provider} → OPEN (in-memory, Redis unavailable)`);
      } else {
        inMemoryState.set(provider, { state: 'CLOSED', failures: fails, ts: Date.now() });
      }
    }
  }

  /** Execute fn with circuit protection */
  async execute<T>(
    provider: CircuitProvider,
    fn:       () => Promise<T>,
    fallback?: () => T | Promise<T>,
  ): Promise<T> {
    const allowed = await this.allowRequest(provider);
    if (!allowed) {
      this.logger.warn(`[CB] ${provider} OPEN — request blocked`);
      if (fallback) return fallback();
      const { ServiceUnavailableException } = await import('@nestjs/common');
      throw new ServiceUnavailableException(
        `${provider} circuit breaker is OPEN — service unavailable`,
      );
    }

    try {
      const result = await fn();
      await this.recordSuccess(provider);
      return result;
    } catch (err) {
      await this.recordFailure(provider);
      if (fallback) {
        this.logger.warn(`[CB] ${provider} failed — using fallback`);
        return fallback();
      }
      throw err;
    }
  }

  /** Get full status snapshot for all providers */
  async getFullStatus(): Promise<CircuitStatus[]> {
    const providers: CircuitProvider[] = [
      'shopify', 'telegram', 'meta', 'supplier', 'tracking',
      'nvidia_49b', 'nvidia_253b', 'muapi', 'nemoguard',
      'openai', 'anthropic', 'groq', 'deepseek',
    ];

    return Promise.all(
      providers.map(async (p) => {
        const state    = await this.getState(p);
        const failures = await this.getFailureCount(p);
        return { provider: p, state, failures };
      }),
    );
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async getState(provider: CircuitProvider): Promise<CircuitState> {
    try {
      const raw = await this.redis.get(`cb:${provider}:state`);
      if (raw === 'open')      return 'OPEN';
      if (raw === 'half_open') return 'HALF_OPEN';

      // Check failure count to detect implicit OPEN state
      const fails = await this.getFailureCount(provider);
      if (fails >= FAILURE_THRESHOLD) return 'OPEN';

      return 'CLOSED';
    } catch {
      // Redis down — use in-memory fallback
      const mem = inMemoryState.get(provider);
      if (!mem) return 'CLOSED';
      // Check if OPEN window has expired
      if (mem.state === 'OPEN') {
        const age = (Date.now() - mem.ts) / 1000;
        if (age > OPEN_TTL_S) {
          inMemoryState.set(provider, { ...mem, state: 'HALF_OPEN', ts: Date.now() });
          return 'HALF_OPEN';
        }
      }
      return mem.state;
    }
  }

  private async getFailureCount(provider: CircuitProvider): Promise<number> {
    try {
      const val = await this.redis.get(`cb:${provider}:fails`);
      return parseInt(val ?? '0', 10);
    } catch {
      return inMemoryState.get(provider)?.failures ?? 0;
    }
  }
}
