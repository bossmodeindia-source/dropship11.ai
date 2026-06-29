import { Injectable, Inject, Logger } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { createHash } from 'crypto';

// ── Public types ──────────────────────────────────────────────────────────────

export type AdMediaAsset = typeof schema.adMediaAssets.$inferSelect;

export interface SaveAssetDto {
  productId:        string;
  campaignId?:      string | null;
  imageUrl:         string;
  videoUrl:         string;
  promptHash:       string;
  provider:         string;
  generationTimeMs: number;
  success:          boolean;
}

// ── Repository ────────────────────────────────────────────────────────────────

@Injectable()
export class AdMediaAssetsRepository {
  private readonly logger = new Logger(AdMediaAssetsRepository.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ── Hash helper ───────────────────────────────────────────────────────────

  /**
   * Deterministic SHA-256 cache key.
   * SHA256( title + '::' + niche + '::' + style )
   * Changing STYLE_KEY in AiMediaService busts all cache entries globally.
   */
  static buildPromptHash(
    title: string,
    niche: string,
    style: string = 'ecom-1:1-9:16',
  ): string {
    return createHash('sha256')
      .update(`${title.trim()}::${niche.trim()}::${style}`)
      .digest('hex');
  }

  // ── Cache lookup ──────────────────────────────────────────────────────────

  /**
   * Returns a cached asset for the given prompt hash, or null on miss.
   * Only serves rows where success = true (skips failed/fallback entries).
   */
  async findByHash(promptHash: string): Promise<AdMediaAsset | null> {
    try {
      const rows = await this.db
        .select()
        .from(schema.adMediaAssets)
        .where(eq(schema.adMediaAssets.promptHash, promptHash))
        .limit(1);

      const row = rows[0] ?? null;
      if (!row) return null;

      // Do not serve entries where generation previously failed
      if (!row.success) {
        this.logger.debug(
          `Cache hit hash=${promptHash.slice(0, 12)}… but success=false — bypassing`,
        );
        return null;
      }

      return row;
    } catch (err) {
      this.logger.error(`findByHash error: ${(err as Error).message}`);
      return null; // treat DB errors as cache miss
    }
  }

  // ── Persist (UPSERT) ──────────────────────────────────────────────────────

  /**
   * FIX 3: Uses INSERT ... ON CONFLICT (prompt_hash) DO NOTHING to safely
   * handle concurrent requests generating the same asset simultaneously.
   * The UNIQUE constraint on prompt_hash (added in migration) ensures only
   * one row exists per hash — subsequent concurrent INSERTs are silently
   * discarded and the caller falls through to findByHash.
   */
  async save(dto: SaveAssetDto): Promise<AdMediaAsset | null> {
    try {
      const rows = await this.db
        .insert(schema.adMediaAssets)
        .values({
          productId:        dto.productId,
          campaignId:       dto.campaignId ?? null,
          imageUrl:         dto.imageUrl,
          videoUrl:         dto.videoUrl,
          promptHash:       dto.promptHash,
          provider:         dto.provider,
          generationTimeMs: dto.generationTimeMs,
          success:          dto.success,
          useCount:         1,
        })
        .onConflictDoNothing({ target: schema.adMediaAssets.promptHash })
        .returning();

      if (!rows[0]) {
        // Conflict: row already inserted by a concurrent request
        this.logger.debug(
          `UPSERT conflict on prompt_hash=${dto.promptHash.slice(0, 12)}… — fetching existing`,
        );
        return this.findByHash(dto.promptHash);
      }

      return rows[0];
    } catch (err) {
      this.logger.error(`save error: ${(err as Error).message}`);
      return null; // non-fatal
    }
  }

  // ── Use-count ────────────────────────────────────────────────────────────

  /**
   * Atomically increments use_count for a served cache entry.
   * Fire-and-forget — never throws.
   */
  async incrementUseCount(id: string): Promise<void> {
    try {
      await this.db
        .update(schema.adMediaAssets)
        .set({ useCount: sql`${schema.adMediaAssets.useCount} + 1` })
        .where(eq(schema.adMediaAssets.id, id));
    } catch (err) {
      this.logger.error(`incrementUseCount id=${id}: ${(err as Error).message}`);
    }
  }

  // ── Best creative ─────────────────────────────────────────────────────────

  /**
   * Returns the best creative for a product:
   *   - Highest use_count first (most-proven creative)
   *   - Most recent as tiebreaker
   *   - Only successful entries
   */
  async getBestCreative(productId: string): Promise<AdMediaAsset | null> {
    try {
      const rows = await this.db
        .select()
        .from(schema.adMediaAssets)
        .where(
          sql`${schema.adMediaAssets.productId} = ${productId}
            AND ${schema.adMediaAssets.success} = true`,
        )
        .orderBy(
          desc(schema.adMediaAssets.useCount),
          desc(schema.adMediaAssets.createdAt),
        )
        .limit(1);

      return rows[0] ?? null;
    } catch (err) {
      this.logger.error(
        `getBestCreative productId=${productId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ── List (admin / debug) ──────────────────────────────────────────────────

  async listByProduct(productId: string, limit = 20): Promise<AdMediaAsset[]> {
    try {
      return await this.db
        .select()
        .from(schema.adMediaAssets)
        .where(eq(schema.adMediaAssets.productId, productId))
        .orderBy(desc(schema.adMediaAssets.createdAt))
        .limit(limit);
    } catch (err) {
      this.logger.error(`listByProduct error: ${(err as Error).message}`);
      return [];
    }
  }
}
