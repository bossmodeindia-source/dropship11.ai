import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AiCreativeProviderService } from './ai-creative-provider.service';
import type { ProductContext, AdCreativeBundle, VideoScript } from './template-engine';
import {
  buildHooks,
  buildCaptions,
  buildHeadlines,
  buildVideoScript,
} from './template-engine';

export type { AdCreativeBundle, VideoScript };

type Product = typeof schema.products.$inferSelect;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class CreativeGeneratorService {
  private readonly logger = new Logger(CreativeGeneratorService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly aiProvider: AiCreativeProviderService,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /** Generate 3 hooks for a product (template or AI). */
  async generateHooks(product: Product): Promise<string[]> {
    try {
      const ctx = this.toContext(product);
      if (this.aiProvider.hasRealKey) {
        const result = await this.aiProvider.generate(ctx);
        return result.bundle.hooks;
      }
      return buildHooks(ctx);
    } catch (err) {
      this.logger.error(`generateHooks error: ${(err as Error).message}`);
      return buildHooks(this.toContext(product));
    }
  }

  /** Generate 3 captions for a product. */
  async generateAdCopy(product: Product): Promise<string[]> {
    try {
      const ctx = this.toContext(product);
      if (this.aiProvider.hasRealKey) {
        const result = await this.aiProvider.generate(ctx);
        return result.bundle.captions;
      }
      return buildCaptions(ctx);
    } catch (err) {
      this.logger.error(`generateAdCopy error: ${(err as Error).message}`);
      return buildCaptions(this.toContext(product));
    }
  }

  /** Generate 2 headlines for a product. */
  async generateHeadlines(product: Product): Promise<string[]> {
    try {
      const ctx = this.toContext(product);
      if (this.aiProvider.hasRealKey) {
        const result = await this.aiProvider.generate(ctx);
        return result.bundle.headlines;
      }
      return buildHeadlines(ctx);
    } catch (err) {
      this.logger.error(`generateHeadlines error: ${(err as Error).message}`);
      return buildHeadlines(this.toContext(product));
    }
  }

  /** Generate a 15–30 sec video script for a product. */
  async generateVideoScript(product: Product): Promise<VideoScript> {
    try {
      const ctx = this.toContext(product);
      if (this.aiProvider.hasRealKey) {
        const result = await this.aiProvider.generate(ctx);
        return result.bundle.videoScript;
      }
      return buildVideoScript(ctx);
    } catch (err) {
      this.logger.error(`generateVideoScript error: ${(err as Error).message}`);
      return buildVideoScript(this.toContext(product));
    }
  }

  /**
   * Full bundle: all 3 hooks + 3 captions + 2 headlines + video script.
   * Single AI call when AI is available; pure templates otherwise.
   * Persists to `ad_creative_assets` and returns the stored row.
   */
  async generateAndStore(
    product:    Product,
    userId:     string,
    campaignId: string | null = null,
  ): Promise<typeof schema.adCreativeAssets.$inferSelect> {
    try {
      const ctx    = this.toContext(product);
      const result = await this.aiProvider.generate(ctx);
      const { hooks, captions, headlines, videoScript } = result.bundle;

      const [row] = await this.db
        .insert(schema.adCreativeAssets)
        .values({
          productId:   product.id,
          userId,
          campaignId:  campaignId ?? null,
          hooks,
          captions,
          headlines,
          videoScript: videoScript as unknown as Record<string, unknown>,
          aiGenerated: result.aiGenerated,
          model:       result.model,
        })
        .returning();

      this.logger.log(
        `Creative assets stored – id=${row.id} product=${product.id} ` +
        `ai=${result.aiGenerated} model=${result.model}`,
      );

      return row;
    } catch (err) {
      // Safety: log only, never crash the system
      this.logger.error(
        `generateAndStore failed product=${product.id}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      // Return a minimal in-memory fallback row so callers always get usable data
      return this.buildFallbackRow(product, userId, campaignId);
    }
  }

  /**
   * Convenience: get the best headline + caption pair for a product.
   * Used by MetaAdsService when building ad creatives.
   * Always returns something — never throws.
   */
  async getBestCreativePair(
    product:    Product,
    userId:     string,
    campaignId: string | null = null,
  ): Promise<{ headline: string; body: string; hooks: string[]; videoScript: VideoScript }> {
    try {
      const row = await this.generateAndStore(product, userId, campaignId);
      return {
        headline:    (row.headlines as string[])[0] ?? `${product.title} – Shop Now!`,
        body:        (row.captions  as string[])[0] ?? `Get ${product.title} today.`,
        hooks:       (row.hooks     as string[]),
        videoScript: row.videoScript as unknown as VideoScript,
      };
    } catch (err) {
      this.logger.error(`getBestCreativePair fallback triggered: ${(err as Error).message}`);
      const ctx = this.toContext(product);
      return {
        headline:    buildHeadlines(ctx)[0],
        body:        buildCaptions(ctx)[0],
        hooks:       buildHooks(ctx),
        videoScript: buildVideoScript(ctx),
      };
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private toContext(p: Product): ProductContext {
    return {
      title:        p.title,
      category:     p.category,
      description:  p.description,
      tags:         p.tags ?? [],
      sellingPrice: p.sellingPrice,
      supplierPrice: p.supplierPrice,
    };
  }

  private buildFallbackRow(
    product:    Product,
    userId:     string,
    campaignId: string | null,
  ): typeof schema.adCreativeAssets.$inferSelect {
    const ctx    = this.toContext(product);
    const hooks  = buildHooks(ctx);
    const caps   = buildCaptions(ctx);
    const heads  = buildHeadlines(ctx);
    const script = buildVideoScript(ctx);
    const now    = new Date();

    return {
      id:          'fallback-' + product.id,
      productId:   product.id,
      userId,
      campaignId:  campaignId ?? null,
      hooks,
      captions:    caps,
      headlines:   heads,
      videoScript: script as unknown as unknown as Record<string, unknown>,
      aiGenerated: false,
      model:       'template-fallback',
      createdAt:   now,
      updatedAt:   now,
    };
  }
}
