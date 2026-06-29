/**
 * SemanticCacheService — PATCHED v2
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX #4 — CACHE TIER ISOLATION (Free users were getting premium AI responses)
 *
 *   BEFORE: Cache key was user-agnostic → free user query hit cache entry
 *           populated by a pro user's expensive 253B call. Free users got
 *           253B-quality responses at $0 cost, undermining the tier model.
 *
 *   AFTER:  tier is now a component of the cache key:
 *             SHA256( op + category + normalised_title + price_bucket + tier )
 *           Cache entries are tier-scoped:
 *             free → BOT responses only
 *             pro  → NVIDIA 49B responses
 *             enterprise → NVIDIA 253B responses
 *           No cross-tier bleeding. Premium users still benefit from their
 *           own tier cache. Free user load does not pollute premium cache.
 *
 * All other behaviour unchanged:
 *   L1 — Redis (TTL 4h)         : hot data, <1ms latency
 *   L2 — PostgreSQL ai_cache    : warm data (TTL 7d), cross-session persistence
 *   Fail-open: Redis/Postgres down → transparent to callers
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as crypto from 'crypto';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { Injectable, Logger, Inject } from '@nestjs/common';

import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, lt, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { OrchestratorRequest } from './ai-provider-dispatcher.service';

const L1_TTL_SECONDS  = 4 * 3600;   // 4 hours
const L2_TTL_INTERVAL = '7 days';

@Injectable()
export class SemanticCacheService {
  private readonly logger = new Logger(SemanticCacheService.name);

  constructor(
    @Inject(REDIS_CLIENT)          private readonly redis: Redis,
    @Inject(DB_TOKEN)       private readonly db:    NodePgDatabase<typeof schema>,
  ) {}

  // ── Key building ───────────────────────────────────────────────────────────

  /**
   * FIX #4: tier is now part of the hash.
   * Free users get their own cache partition — they never see pro/enterprise results.
   * Defaults to 'free' if not provided (safe — avoids cache poisoning).
   */
  buildCacheKey(req: OrchestratorRequest): string {
    const tier = req.userTier ?? 'free';

    const normalized = {
      op:       req.operation,
      category: ((req.context['category'] as string) ?? '').toLowerCase().trim(),
      title:    this.normalizeTitle((req.context['title'] as string) ?? ''),
      price:    this.priceBucket((req.context['sellingPrice'] as number) ?? 0),
      // FIX #4: Tier scopes the cache partition — free never hits pro cache
      tier,
    };
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
  }

  // ── L1 — Redis ─────────────────────────────────────────────────────────────

  async getL1(key: string): Promise<unknown | null> {
    try {
      const raw = await this.redis.get(`ai:cache:${key}`);
      if (raw) {
        this.logger.debug(`[Cache L1] HIT ${key.slice(0, 8)}…`);
        return JSON.parse(raw) as unknown;
      }
      return null;
    } catch {
      return null;
    }
  }

  async setL1(key: string, value: unknown, ttlSeconds = L1_TTL_SECONDS): Promise<void> {
    try {
      await this.redis.set(
        `ai:cache:${key}`,
        JSON.stringify(value),
        'EX', ttlSeconds,
      );
    } catch { /* silent */ }
  }

  async deleteL1(key: string): Promise<void> {
    try { await this.redis.del(`ai:cache:${key}`); } catch { /* silent */ }
  }

  // ── L2 — PostgreSQL ────────────────────────────────────────────────────────

  async getL2(key: string): Promise<unknown | null> {
    try {
      const row = await this.db.query.aiCache.findFirst({
        where: eq(schema.aiCache.cacheKey, key),
      });

      if (!row) return null;

      if (new Date(row.expiresAt) < new Date()) {
        void this.db.delete(schema.aiCache).where(eq(schema.aiCache.cacheKey, key));
        return null;
      }

      this.logger.debug(`[Cache L2] HIT ${key.slice(0, 8)}…`);

      void this.db.execute(
        sql`UPDATE ai_cache SET hit_count = hit_count + 1, last_hit_at = NOW()
            WHERE cache_key = ${key}`,
      );

      return row.content as unknown;
    } catch {
      return null;
    }
  }

  // ── Write-back ─────────────────────────────────────────────────────────────

  async writeBack(
    key:       string,
    content:   unknown,
    operation: string,
    category:  string,
  ): Promise<void> {
    void this.setL1(key, content, L1_TTL_SECONDS);

    try {
      await this.db
        .insert(schema.aiCache)
        .values({
          cacheKey:  key,
          operation,
          category,
          content:   content as Record<string, unknown>,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        })
        .onConflictDoUpdate({
          target: schema.aiCache.cacheKey,
          set: {
            hitCount:  sql`${schema.aiCache.hitCount} + 1`,
            lastHitAt: new Date(),
            expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
          },
        });
    } catch (err) {
      this.logger.warn(`[Cache] L2 write-back failed: ${(err as Error).message}`);
    }
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  async evictExpired(): Promise<number> {
    try {
      const result = await this.db
        .delete(schema.aiCache)
        .where(lt(schema.aiCache.expiresAt, new Date()));
      return (result as unknown as { rowCount: number }).rowCount ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\b(premium|best|top|ultimate|new|amazing|professional|high.quality)\b/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join(' ');
  }

  private priceBucket(price: number): string {
    if (price < 10)  return '0-10';
    if (price < 30)  return '10-30';
    if (price < 75)  return '30-75';
    if (price < 150) return '75-150';
    return '150+';
  }
}
