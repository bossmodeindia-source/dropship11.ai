/**
 * TenantRateLimiterService
 *
 * Enforces two layers of rate limiting using Redis atomic Lua scripts:
 *
 *   1. Per-tenant sliding window  — prevents any single tenant from flooding
 *      the queue regardless of how many bots they own.
 *
 *   2. Global concurrency cap     — hard ceiling on simultaneously-active jobs
 *      across the entire platform (800 concurrent bot executions).
 *
 * Both checks use a single Redis EVAL call per limit check, making them
 * atomic and safe under concurrent orchestrator instances.
 *
 * Redis key layout:
 *   rl:tenant:{tenant_id}  → sliding-window sorted set  (TTL = window)
 *   rl:global:active       → integer counter             (no TTL — decremented by workers)
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import {
  GLOBAL_CONCURRENCY_CAP,
  TIER_LIMITS,
  TenantTier,
} from '../queues/bot-queue.constants';

export interface RateLimitResult {
  allowed:    boolean;
  reason?:    'tenant_limit' | 'global_cap' | 'backpressure';
  retryAfterMs?: number;
  currentCount?: number;
  limit?:     number;
}

@Injectable()
export class TenantRateLimiterService {
  private readonly logger = new Logger(TenantRateLimiterService.name);

  // Lua: sliding-window counter using a sorted-set keyed by timestamp.
  // Returns 1 (allowed) or 0 (denied) and cleans up stale entries atomically.
  private readonly SLIDING_WINDOW_LUA = `
    local key      = KEYS[1]
    local now      = tonumber(ARGV[1])
    local window   = tonumber(ARGV[2])
    local limit    = tonumber(ARGV[3])
    local jobId    = ARGV[4]
    local cutoff   = now - window

    redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
    local count = redis.call('ZCARD', key)

    if count < limit then
      redis.call('ZADD', key, now, jobId)
      redis.call('PEXPIRE', key, window)
      return {1, count + 1, limit}
    end
    return {0, count, limit}
  `;

  // Lua: increment global counter only if below cap — atomic CAS.
  private readonly GLOBAL_CAP_LUA = `
    local key = KEYS[1]
    local cap = tonumber(ARGV[1])
    local cur = tonumber(redis.call('GET', key) or '0')
    if cur < cap then
      redis.call('INCR', key)
      return {1, cur + 1, cap}
    end
    return {0, cur, cap}
  `;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Check and record a new job attempt for a tenant.
   * Must be called BEFORE enqueuing. If allowed, the slot is reserved.
   */
  async checkAndRecord(
    tenantId: string,
    tier: TenantTier,
    jobId: string,
  ): Promise<RateLimitResult> {
    // ── 1. Tenant sliding-window check ──────────────────────────────────────
    const { maxJobs, windowMs } = TIER_LIMITS[tier];
    const tenantKey = `rl:tenant:${tenantId}`;
    const now       = Date.now();

    const [tenantAllowed, tenantCount, tenantLimit] = await this.redis.eval(
      this.SLIDING_WINDOW_LUA,
      1,
      tenantKey,
      String(now),
      String(windowMs),
      String(maxJobs),
      jobId,
    ) as [number, number, number];

    if (!tenantAllowed) {
      this.logger.warn(
        `[RateLimit] Tenant ${tenantId} at limit: ${tenantCount}/${tenantLimit} in ${windowMs}ms window`,
      );
      return {
        allowed:      false,
        reason:       'tenant_limit',
        retryAfterMs: windowMs,
        currentCount: tenantCount,
        limit:        tenantLimit,
      };
    }

    // ── 2. Global concurrency cap ────────────────────────────────────────────
    const [globalAllowed, globalCount, globalCap] = await this.redis.eval(
      this.GLOBAL_CAP_LUA,
      1,
      'rl:global:active',
      String(GLOBAL_CONCURRENCY_CAP),
    ) as [number, number, number];

    if (!globalAllowed) {
      // Roll back the tenant slot we just reserved
      await this.redis.zrem(tenantKey, jobId);

      this.logger.warn(
        `[RateLimit] Global cap reached: ${globalCount}/${globalCap} active jobs`,
      );
      return {
        allowed:      false,
        reason:       'global_cap',
        retryAfterMs: 5_000,
        currentCount: globalCount,
        limit:        globalCap,
      };
    }

    return { allowed: true, currentCount: tenantCount, limit: tenantLimit };
  }

  /**
   * Decrement the global concurrency counter when a job completes or fails.
   * Workers MUST call this in their finally block.
   */
  async releaseSlot(): Promise<void> {
    const current = await this.redis.decr('rl:global:active');
    // Guard against drift below 0 (e.g. crash + restart scenarios)
    if (current < 0) {
      await this.redis.set('rl:global:active', 0);
    }
  }

  /** Read-only snapshot of current global load. */
  async getGlobalLoad(): Promise<{ active: number; cap: number; utilization: number }> {
    const active = parseInt((await this.redis.get('rl:global:active')) ?? '0', 10);
    return {
      active,
      cap:         GLOBAL_CONCURRENCY_CAP,
      utilization: active / GLOBAL_CONCURRENCY_CAP,
    };
  }

  /** Read-only snapshot of a single tenant's current window usage. */
  async getTenantLoad(tenantId: string, tier: TenantTier): Promise<{ count: number; limit: number }> {
    const { maxJobs, windowMs } = TIER_LIMITS[tier];
    const cutoff = Date.now() - windowMs;
    const count  = await this.redis.zcount(`rl:tenant:${tenantId}`, cutoff, '+inf');
    return { count, limit: maxJobs };
  }
}
