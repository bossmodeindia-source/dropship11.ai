/**
 * CooldownService
 *
 * Enforces per-user, per-operation cooldown windows in Redis.
 * Primary use: 253B strategy calls are rate-limited to once per 24h per user.
 *
 * Redis unavailable → cooldowns silently ignored (fail open).
 * This is intentional: a Redis blip should not prevent strategy calls.
 */

import { Injectable, Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../common/redis/redis.module';

import type Redis from 'ioredis';

@Injectable()
export class CooldownService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Returns true if the user is currently in cooldown for this operation.
   */
  async isInCooldown(userId: string, operation: string, ttlMinutes: number): Promise<boolean> {
    try {
      const key    = this.key(userId, operation);
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch {
      return false; // Fail open
    }
  }

  /**
   * Set cooldown for a user+operation combination.
   * Called after a successful 253B invocation.
   */
  async setCooldown(userId: string, operation: string, ttlMinutes: number): Promise<void> {
    try {
      await this.redis.set(
        this.key(userId, operation),
        '1',
        'EX', ttlMinutes * 60,
      );
    } catch { /* silent */ }
  }

  /**
   * Remaining cooldown in seconds. Returns 0 if not in cooldown.
   */
  async remainingSeconds(userId: string, operation: string): Promise<number> {
    try {
      const ttl = await this.redis.ttl(this.key(userId, operation));
      return ttl > 0 ? ttl : 0;
    } catch {
      return 0;
    }
  }

  private key(userId: string, operation: string): string {
    return `ai:cooldown:${userId}:${operation}`;
  }
}
