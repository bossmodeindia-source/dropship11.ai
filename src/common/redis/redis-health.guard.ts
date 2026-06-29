/**
 * RedisHealthGuard — V66 FAIL-CLOSED Redis Safety
 *
 * States: NORMAL → DEGRADED → FAIL_CLOSED
 *
 * If Redis is unavailable, BLOCK all:
 *   - payments
 *   - webhooks
 *   - fulfillment
 *   - supplier routing
 *
 * Returns 503 Service Unavailable when fail-closed.
 *
 * Never process critical events without locks or idempotency.
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ServiceUnavailableException,
  Logger,
  Inject,
  OnModuleDestroy,
} from '@nestjs/common';
import { Reflector }  from '@nestjs/core';
import { Redis }      from 'ioredis';
<<<<<<< HEAD
import { InjectRedis } from './inject-redis';
=======
import { InjectRedis } from '@liaoliaots/nestjs-redis';
>>>>>>> a1b8c0c1cff445126259345924e07d81a359e9bd

export const REQUIRES_REDIS = 'requires_redis';

/** Decorator — mark controller methods that MUST have Redis available */
export const RequiresRedis = () =>
  (target: object, key: string, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(REQUIRES_REDIS, true, descriptor.value);
    return descriptor;
  };

export enum RedisHealthState {
  NORMAL     = 'NORMAL',
  DEGRADED   = 'DEGRADED',
  FAIL_CLOSED = 'FAIL_CLOSED',
}

@Injectable()
export class RedisHealthGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthGuard.name);
  private state: RedisHealthState = RedisHealthState.NORMAL;
  private consecutiveFailures = 0;
  private readonly DEGRADE_THRESHOLD  = 3;
  private readonly FAILCLOSE_THRESHOLD = 5;
  private readonly probeTimer: ReturnType<typeof setInterval>;

  /** Critical route prefixes — always blocked when Redis unavailable (REQUIREMENT 10) */
  private readonly CRITICAL_PATHS = [
    '/api/payment',
    '/api/escrow',
    '/api/withdrawal',
    '/api/supplier-payment',
    '/webhooks',
    '/api/fulfillment',
    '/api/supplier',
    '/api/orders/pay',
    '/api/checkout',
  ];

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly reflector: Reflector,
  ) {
    // Periodic Redis health probe every 10 seconds
    this.probeTimer = setInterval(() => this.probeRedis(), 10_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.probeTimer);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ path: string }>();
    const isCriticalPath = this.CRITICAL_PATHS.some(p =>
      request.path?.startsWith(p),
    );

    if (!isCriticalPath) return true;

    if (this.state === RedisHealthState.FAIL_CLOSED) {
      this.logger.error(
        `[FAIL-CLOSED] Blocking critical request to ${request.path} — Redis unavailable`,
      );
      throw new ServiceUnavailableException(
        'Service temporarily unavailable — core infrastructure degraded. Please retry in 30 seconds.',
      );
    }

    // Live-probe for DEGRADED state on critical paths
    if (this.state === RedisHealthState.DEGRADED) {
      const alive = await this.pingRedis();
      if (!alive) {
        throw new ServiceUnavailableException(
          'Service temporarily unavailable — Redis health check failed.',
        );
      }
    }

    return true;
  }

  getState(): RedisHealthState { return this.state; }

  private async probeRedis(): Promise<void> {
    const alive = await this.pingRedis();

    if (alive) {
      if (this.consecutiveFailures > 0) {
        this.logger.log(`Redis recovered after ${this.consecutiveFailures} failures — state=NORMAL`);
      }
      this.consecutiveFailures = 0;
      this.state = RedisHealthState.NORMAL;
    } else {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.FAILCLOSE_THRESHOLD) {
        if (this.state !== RedisHealthState.FAIL_CLOSED) {
          this.logger.error(
            `[FAIL-CLOSED] Redis down for ${this.consecutiveFailures} probes — entering FAIL_CLOSED state`,
          );
        }
        this.state = RedisHealthState.FAIL_CLOSED;
      } else if (this.consecutiveFailures >= this.DEGRADE_THRESHOLD) {
        if (this.state !== RedisHealthState.DEGRADED) {
          this.logger.warn(
            `[DEGRADED] Redis probe failed ${this.consecutiveFailures} times — entering DEGRADED state`,
          );
        }
        this.state = RedisHealthState.DEGRADED;
      }
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
