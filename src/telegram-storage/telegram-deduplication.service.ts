/**
 * TelegramDeduplicationService — SHA-256 checksum-based deduplication.
 *
 * Before any upload:
 *   1. Compute SHA-256 of the file buffer.
 *   2. Check Redis cache (fast path).
 *   3. Check DB (source of truth).
 *   4. If found → reuse existing telegram_file_id, skip upload.
 *   5. If not found → proceed with upload, cache result.
 *
 * Tenant-scoped: each tenant has its own dedup namespace.
 * Cross-tenant dedup is intentionally disabled (data isolation).
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { createHash }                 from 'crypto';
import Redis                          from 'ioredis';
import { REDIS_CLIENT }               from '../common/redis/redis.module';
import { TelegramAssetRepository }    from './telegram-asset.repository';
import { TelegramAssetRow }           from './telegram-storage.schema';

const DEDUP_CACHE_TTL = 86_400; // 24h

@Injectable()
export class TelegramDeduplicationService {
  private readonly logger = new Logger(TelegramDeduplicationService.name);

  constructor(
    private readonly repo: TelegramAssetRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Compute SHA-256 hex of a Buffer or base64 string */
  computeChecksum(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'base64') : input;
    return createHash('sha256').update(buf).digest('hex');
  }

  /**
   * Check for an existing asset with the same checksum in this tenant's namespace.
   * Returns the existing asset row if found (to reuse file_id), or null.
   */
  async findDuplicate(tenantId: string, checksum: string): Promise<TelegramAssetRow | null> {
    // 1. Redis hot-cache (key → assetId)
    const cacheKey = `tg:dedup:${tenantId}:${checksum}`;
    const cached   = await this.redis.get(cacheKey).catch(() => null);

    if (cached) {
      const row = await this.repo.findById(cached, tenantId).catch(() => null);
      if (row?.telegram_file_id) {
        this.logger.debug(`Dedup cache hit: tenant=${tenantId} checksum=${checksum.slice(0, 8)}…`);
        return row;
      }
      // Stale cache entry — remove it
      await this.redis.del(cacheKey).catch(() => {});
    }

    // 2. DB lookup
    const row = await this.repo.findByChecksum(tenantId, checksum);
    if (row?.telegram_file_id) {
      // Prime the cache
      await this.redis
        .setex(cacheKey, DEDUP_CACHE_TTL, row.id)
        .catch(() => {});
      this.logger.debug(`Dedup DB hit: tenant=${tenantId} assetId=${row.id}`);
      return row;
    }

    return null;
  }

  /** After a successful upload, cache the checksum → assetId mapping */
  async cacheChecksum(tenantId: string, checksum: string, assetId: string): Promise<void> {
    const cacheKey = `tg:dedup:${tenantId}:${checksum}`;
    await this.redis.setex(cacheKey, DEDUP_CACHE_TTL, assetId).catch(() => {});
  }

  /** Invalidate a checksum from cache (e.g. after deletion) */
  async invalidateChecksum(tenantId: string, checksum: string): Promise<void> {
    const cacheKey = `tg:dedup:${tenantId}:${checksum}`;
    await this.redis.del(cacheKey).catch(() => {});
  }
}
