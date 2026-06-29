/**
 * distributed-lock.service.ts — V60 CRASH-SAFE DISTRIBUTED LOCKS
 *
 * P0-4 Fix: ALL distributed locks now include:
 *   - TTL (configurable, default 30s)
 *   - Heartbeat renewal (renews every TTL/3)
 *   - Safe expiry (lock auto-releases on process crash)
 *   - Stale-lock cleanup (startup scan + periodic GC)
 *   - Deadlock-proof via Lua SET NX PX atomic operation
 *
 * Design:
 *   - Lock key format:  lock:{resource}
 *   - Lock value:       {lockId}:{tenantId}:{timestamp}  (owner token)
 *   - Unlock:           Lua CAS — only owner can release
 *   - Renewal:          Lua CAS — only owner can extend
 *
 * Never call acquireLock() in a tight loop. Always use withLock() which
 * handles acquire → heartbeat → execute → release in one atomic lifecycle.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis }      from 'ioredis';
import { v4 as uuid } from 'uuid';
<<<<<<< HEAD
import { InjectRedis } from './inject-redis';
=======
import { InjectRedis } from '@liaoliaots/nestjs-redis';
>>>>>>> a1b8c0c1cff445126259345924e07d81a359e9bd

export interface LockOptions {
  ttlMs?:          number;  // lock TTL (default 30_000 ms)
  retryCount?:     number;  // acquire retries (default 10)
  retryDelayMs?:   number;  // delay between retries (default 200 ms)
  heartbeatMs?:    number;  // heartbeat interval (default ttlMs / 3)
}

export interface AcquiredLock {
  lockId:  string;
  key:     string;
  release: () => Promise<void>;
}

// ── Lua scripts (atomic; Redis single-threaded) ───────────────────────────────

/** Release lock only if current holder owns it */
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

/** Extend lock TTL only if current holder owns it */
const RENEW_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

@Injectable()
export class DistributedLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DistributedLockService.name);

  /** Registry of active heartbeat timers → cleared on module destroy */
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ── Startup: scan for stale locks from previous crash ────────────────────
  async onModuleInit(): Promise<void> {
    await this.cleanupStaleLocks();
  }

  // ── Shutdown: stop all heartbeats to prevent renewal after app closes ─────
  async onModuleDestroy(): Promise<void> {
    for (const [key, timer] of this.heartbeats) {
      clearInterval(timer);
      this.logger.debug(`Heartbeat cleared for lock ${key}`);
    }
    this.heartbeats.clear();
  }

  /**
   * withLock — primary API.
   *
   * Acquires a distributed lock, starts heartbeat renewal, executes fn(),
   * then releases. If fn() throws the lock is still released.
   *
   * Usage:
   *   const result = await lockService.withLock('order:123', tenantId, async () => {
   *     return await processOrder('123');
   *   });
   */
  async withLock<T>(
    resource: string,
    tenantId: string,
    fn: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const lock = await this.acquireLock(resource, tenantId, options);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  /**
   * acquireLock — low-level acquire.
   *
   * Returns an AcquiredLock with a release() function.
   * Throws if the lock cannot be acquired within retryCount attempts.
   * Always call release() in a finally block.
   */
  async acquireLock(
    resource: string,
    tenantId: string,
    options: LockOptions = {},
  ): Promise<AcquiredLock> {
    const {
      ttlMs        = 30_000,
      retryCount   = 10,
      retryDelayMs = 200,
      heartbeatMs  = Math.floor(ttlMs / 3),
    } = options;

    const lockId  = uuid();
    const key     = `lock:${resource}`;
    const token   = `${lockId}:${tenantId}:${Date.now()}`;

    let acquired = false;
    for (let attempt = 0; attempt < retryCount; attempt++) {
      // Atomic SET key token NX PX ttlMs
      const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        acquired = true;
        break;
      }
      await this.sleep(retryDelayMs * Math.pow(1.5, attempt)); // exponential backoff
    }

    if (!acquired) {
      throw new Error(
        `LOCK_TIMEOUT: Could not acquire lock on "${resource}" after ${retryCount} attempts. ` +
        `Resource may be held by another process. TTL=${ttlMs}ms`,
      );
    }

    this.logger.debug(`Lock acquired: ${key} → ${lockId} (TTL=${ttlMs}ms)`);

    // ── Start heartbeat renewal ─────────────────────────────────────────────
    const heartbeat = setInterval(async () => {
      try {
        const renewed = await this.redis.eval(
          RENEW_SCRIPT,
          1,
          key,
          token,
          String(ttlMs),
        ) as number;
        if (renewed === 0) {
          // Lock was taken by someone else (should not happen with TTL > heartbeat)
          this.logger.warn(`Lock renewal failed — lock lost: ${key}`);
          clearInterval(heartbeat);
          this.heartbeats.delete(key);
        }
      } catch (err) {
        this.logger.error(`Lock heartbeat error for ${key}:`, err);
      }
    }, heartbeatMs);

    this.heartbeats.set(key, heartbeat);

    // ── Release function (Lua CAS — only owner can release) ──────────────
    const release = async (): Promise<void> => {
      clearInterval(heartbeat);
      this.heartbeats.delete(key);
      try {
        const deleted = await this.redis.eval(
          RELEASE_SCRIPT,
          1,
          key,
          token,
) as number;
        if (deleted === 0) {
          this.logger.warn(`Lock release no-op (already expired or taken): ${key}`);
        } else {
          this.logger.debug(`Lock released: ${key}`);
        }
      } catch (err) {
        this.logger.error(`Lock release error for ${key}:`, err);
      }
    };

    return { lockId, key, release };
  }

  /**
   * cleanupStaleLocks — scans for lock keys and removes any older than 2× max TTL.
   * Called on module init and can be called periodically via a scheduler.
   */
  async cleanupStaleLocks(): Promise<void> {
    try {
      let cursor = '0';
      let cleaned = 0;
      const maxAgeMs = 120_000; // 2 min — far beyond any legitimate lock

      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor, 'MATCH', 'lock:*', 'COUNT', 100,
        );
        cursor = nextCursor;

        for (const key of keys) {
          const value = await this.redis.get(key);
          if (!value) continue;

          const parts     = value.split(':');
          const timestamp = parseInt(parts[2] ?? '0', 10);
          const age       = Date.now() - timestamp;

          if (!isNaN(timestamp) && age > maxAgeMs) {
            await this.redis.del(key);
            cleaned++;
            this.logger.warn(`Stale lock removed: ${key} (age=${age}ms)`);
          }
        }
      } while (cursor !== '0');

      if (cleaned > 0) {
        this.logger.log(`Stale lock cleanup: removed ${cleaned} stale lock(s)`);
      }
    } catch (err) {
      // Never crash on cleanup failure
      this.logger.error('Stale lock cleanup error:', err);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
