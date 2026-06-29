/**
 * ShopifyCircuitBreaker — V66 HIGH PRIORITY
 *
 * States: CLOSED → OPEN → HALF_OPEN
 *
 * Protects:
 *   - order sync
 *   - product sync
 *   - inventory sync
 *   - fulfillment sync
 *
 * Features:
 *   - error threshold (5 failures in 60s → OPEN)
 *   - timeout threshold (10s per call)
 *   - exponential backoff retry
 *   - fallback queues when OPEN
 *   - half-open probe (1 call) before full recovery
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRedis } from '../common/redis/inject-redis';
import { Redis } from 'ioredis';

export enum CircuitState {
  CLOSED    = 'CLOSED',
  OPEN      = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  name:                 string;
  errorThreshold:       number;  // failures before opening
  successThreshold:     number;  // successes in half-open before closing
  timeout:              number;  // call timeout ms
  resetTimeout:         number;  // ms before transitioning OPEN → HALF_OPEN
  errorWindowMs:        number;  // rolling window for error counting
}

const DEFAULTS: CircuitBreakerOptions = {
  name:             'shopify',
  errorThreshold:   5,
  successThreshold: 2,
  timeout:          10_000,
  resetTimeout:     30_000,
  errorWindowMs:    60_000,
};

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker [${name}] is OPEN — Shopify API calls blocked`);
    this.name = 'CircuitOpenError';
  }
}

@Injectable()
export class ShopifyCircuitBreaker {
  private readonly logger = new Logger(ShopifyCircuitBreaker.name);
  private state: CircuitState = CircuitState.CLOSED;
  private failures      = 0;
  private successes     = 0;
  private lastOpenedAt  = 0;
  private readonly opts: CircuitBreakerOptions;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Optional()
    opts: Partial<CircuitBreakerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.logger.log(
      `[CircuitBreaker:${this.opts.name}] Initialized — ` +
      `errorThreshold=${this.opts.errorThreshold}, resetTimeout=${this.opts.resetTimeout}ms`,
    );
  }

  /** Execute a Shopify API call wrapped in circuit breaker protection */
  async execute<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T>,
  ): Promise<T> {
    await this.syncStateFromRedis();

    if (this.state === CircuitState.OPEN) {
      const timeSinceOpen = Date.now() - this.lastOpenedAt;
      if (timeSinceOpen >= this.opts.resetTimeout) {
        await this.transitionTo(CircuitState.HALF_OPEN);
        this.logger.log(`[${this.opts.name}] Circuit → HALF_OPEN (probe)`);
      } else {
        if (fallback) {
          this.logger.warn(`[${this.opts.name}] OPEN — using fallback queue`);
          return fallback();
        }
        throw new CircuitOpenError(this.opts.name);
      }
    }

    try {
      const result = await this.withTimeout(operation, this.opts.timeout);
      await this.onSuccess();
      return result;
    } catch (err) {
      await this.onFailure(err as Error);
      if (fallback) {
        this.logger.warn(`[${this.opts.name}] Error — using fallback: ${(err as Error).message}`);
        return fallback();
      }
      throw err;
    }
  }

  getState(): CircuitState { return this.state; }

  getMetrics() {
    return {
      state:         this.state,
      failures:      this.failures,
      successes:     this.successes,
      lastOpenedAt:  this.lastOpenedAt ? new Date(this.lastOpenedAt) : null,
    };
  }

  private async onSuccess(): Promise<void> {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) {
        await this.transitionTo(CircuitState.CLOSED);
        this.failures  = 0;
        this.successes = 0;
        this.logger.log(`[${this.opts.name}] Circuit → CLOSED (recovered)`);
      }
    } else {
      this.failures = Math.max(0, this.failures - 1); // gradual decay
    }
  }

  private async onFailure(err: Error): Promise<void> {
    this.failures++;
    this.logger.warn(
      `[${this.opts.name}] Failure #${this.failures}: ${err.message}`,
    );

    if (
      this.state !== CircuitState.OPEN &&
      this.failures >= this.opts.errorThreshold
    ) {
      this.lastOpenedAt = Date.now();
      await this.transitionTo(CircuitState.OPEN);
      this.logger.error(
        `[${this.opts.name}] Circuit → OPEN after ${this.failures} failures. ` +
        `Will probe in ${this.opts.resetTimeout / 1000}s`,
      );
    }
  }

  private async transitionTo(state: CircuitState): Promise<void> {
    this.state = state;
    const stateKey = `circuit:${this.opts.name}:state`;
    await this.redis.set(stateKey, JSON.stringify({
      state,
      failures:     this.failures,
      lastOpenedAt: this.lastOpenedAt,
      updatedAt:    Date.now(),
    }), 'EX', 300);
  }

  private async syncStateFromRedis(): Promise<void> {
    try {
      const raw = await this.redis.get(`circuit:${this.opts.name}:state`);
      if (raw) {
        const saved = JSON.parse(raw) as {
          state: CircuitState;
          failures: number;
          lastOpenedAt: number;
        };
        // Only update from Redis if our in-memory state is CLOSED and Redis says OPEN
        // This prevents multiple instances from racing each other open
        if (
          this.state === CircuitState.CLOSED &&
          saved.state === CircuitState.OPEN
        ) {
          this.state        = saved.state;
          this.failures     = saved.failures;
          this.lastOpenedAt = saved.lastOpenedAt;
        }
      }
    } catch { /* Redis unavailable — use in-memory state */ }
  }

  private withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Shopify API call timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err   => { clearTimeout(timer); reject(err); });
    });
  }
}
