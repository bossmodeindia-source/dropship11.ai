/**
 * CacheService — Global Redis-Backed Cache (AUDIT FIX)
 *
 * Unified cache layer replacing scattered ad-hoc Redis calls across modules.
 * All caching MUST go through this service.
 *
 * Features:
 *   - Redis-backed with configurable TTL
 *   - JSON serialization / deserialization
 *   - Fail-safe: cache miss on Redis error (non-critical path)
 *   - Namespaced keys to prevent collisions
 *   - getOrSet() for atomic cache-aside pattern
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

const DEFAULT_TTL_SECONDS = 1800; // 30 minutes

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis!: IORedis;
  private readonly onRedisError = (err: Error) =>
    this.logger.warn(`[Cache] Redis error: ${err.message}`);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.redis = new IORedis({
      host:     this.config.get('REDIS_HOST', 'localhost'),
      port:     this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    this.redis.on('error', this.onRedisError);
    this.logger.log('[Cache] CacheService initialized');
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    this.redis.removeListener('error', this.onRedisError);
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit();
  }

  /**
   * Get a cached value. Returns null on miss or Redis error.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.ns(key));
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(`[Cache] GET failed for key=${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Set a cached value with TTL (seconds). Fail-safe on Redis error.
   */
  async set<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
    try {
      await this.redis.setex(this.ns(key), ttlSeconds, JSON.stringify(value));
    } catch (err) {
      this.logger.warn(`[Cache] SET failed for key=${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a cached value. Fail-safe on Redis error.
   */
  async del(key: string): Promise<void> {
    try {
      await this.redis.del(this.ns(key));
    } catch (err) {
      this.logger.warn(`[Cache] DEL failed for key=${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Atomic cache-aside: get if exists, else compute and store.
   * fn is only called on cache miss.
   */
  async getOrSet<T>(
    key:        string,
    fn:         () => Promise<T>,
    ttlSeconds  = DEFAULT_TTL_SECONDS,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await fn();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /**
   * Check if a key exists.
   */
  async has(key: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(this.ns(key));
      return exists === 1;
    } catch {
      return false;
    }
  }

  /**
   * Delete all keys matching a prefix pattern.
   */
  async delByPrefix(prefix: string): Promise<number> {
    try {
      const keys = await this.redis.keys(this.ns(`${prefix}*`));
      if (keys.length === 0) return 0;
      await this.redis.del(...keys);
      return keys.length;
    } catch (err) {
      this.logger.warn(`[Cache] DEL_PREFIX failed for prefix=${prefix}: ${(err as Error).message}`);
      return 0;
    }
  }

  private ns(key: string): string {
    return `cache:${key}`;
  }
}
