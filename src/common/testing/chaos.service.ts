import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * FIX 6: Chaos Engineering Service
 *
 * Injects controlled failures and latency into service calls to:
 *  - Validate system resilience under adverse conditions
 *  - Verify fallback paths and error handling are reachable
 *  - Simulate real-world intermittent failures (network, timeouts, flakiness)
 *
 * SAFETY: All methods are no-ops unless CHAOS_MODE=true.
 * NEVER enable in production (validated by config guard below).
 *
 * Usage:
 *   await this.chaos.simulateRandomFailure(0.1, 'ai-media.generate');
 *   await this.chaos.simulateLatency(500, 'supplier.fulfill');
 */
@Injectable()
export class ChaosService {
  private readonly logger  = new Logger(ChaosService.name);
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    const chaosMode = this.config.get<string>('CHAOS_MODE', 'false');
    const nodeEnv   = this.config.get<string>('NODE_ENV', 'development');

    // Hard guard: chaos is forbidden in production regardless of env var
    if (chaosMode === 'true' && nodeEnv === 'production') {
      this.logger.error(
        'CHAOS_MODE=true is NOT allowed in NODE_ENV=production. Chaos mode disabled.',
      );
      this.enabled = false;
    } else {
      this.enabled = chaosMode === 'true';
    }

    if (this.enabled) {
      this.logger.warn(
        '⚡ CHAOS MODE ACTIVE — random failures and latency injection enabled. ' +
        'Do NOT use in production.',
      );
    }
  }

  /**
   * Throws a ChaosError with the given probability.
   *
   * @param probability  0.0–1.0 chance of throwing (default 0.1 = 10%)
   * @param label        Descriptive label for logging (e.g. 'meta-ads.fetch')
   *
   * @example
   *   await this.chaos.simulateRandomFailure(0.2, 'shopify.get-order');
   *   // → 20% chance of throwing Error('[CHAOS] Simulated failure at shopify.get-order')
   */
  async simulateRandomFailure(probability = 0.1, label = 'unknown'): Promise<void> {
    if (!this.enabled) return;

    if (probability < 0 || probability > 1) {
      throw new Error(`ChaosService: probability must be 0–1, got ${probability}`);
    }

    if (Math.random() < probability) {
      this.logger.warn(
        `[CHAOS] Injecting failure at=${label} probability=${probability}`,
      );
      throw new ChaosError(`[CHAOS] Simulated failure at ${label}`);
    }
  }

  /**
   * Injects artificial latency.
   *
   * @param delayMs  Milliseconds to sleep
   * @param label    Descriptive label for logging
   *
   * @example
   *   await this.chaos.simulateLatency(2000, 'supplier.api');
   *   // → always sleeps 2 seconds when CHAOS_MODE=true
   */
  async simulateLatency(delayMs: number, label = 'unknown'): Promise<void> {
    if (!this.enabled) return;

    if (delayMs < 0) {
      throw new Error(`ChaosService: delayMs must be >= 0, got ${delayMs}`);
    }

    this.logger.warn(
      `[CHAOS] Injecting latency delayMs=${delayMs} at=${label}`,
    );
    await sleep(delayMs);
  }

  /**
   * Simulate a network timeout by sleeping longer than the typical timeout.
   * Useful for testing AbortSignal / timeout handling.
   */
  async simulateTimeout(timeoutMs = 30_000, label = 'unknown'): Promise<void> {
    if (!this.enabled) return;
    this.logger.warn(
      `[CHAOS] Simulating timeout (${timeoutMs}ms) at=${label}`,
    );
    await sleep(timeoutMs);
  }

  /**
   * Randomly inject one of: failure, latency, or nothing.
   * Convenient for sprinkling chaos across a service without precise control.
   *
   * @param failProbability   Chance of throwing  (default 5%)
   * @param latencyProbability Chance of sleeping 500–2000ms (default 10%)
   */
  async simulateChaos(
    label          = 'unknown',
    failProbability    = 0.05,
    latencyProbability = 0.10,
  ): Promise<void> {
    if (!this.enabled) return;

    const roll = Math.random();

    if (roll < failProbability) {
      await this.simulateRandomFailure(1, label);
    } else if (roll < failProbability + latencyProbability) {
      const delayMs = 500 + Math.floor(Math.random() * 1500); // 500–2000ms
      await this.simulateLatency(delayMs, label);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Typed error class so callers can distinguish chaos-injected errors
 * from real errors in tests and catch blocks.
 */
export class ChaosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChaosError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
