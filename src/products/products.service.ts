/**
 * ProductsService (V2 — AI-Queue Updated)
 *
 * Key changes from V1:
 *  1. scoreAndDecide() no longer calls aiMedia.generateAdMedia() directly.
 *     Instead, it enqueues a JOB_MEDIA_GENERATE job to ai:background so
 *     the HTTP response returns immediately and never blocks on AI calls.
 *
 *  2. generateListing() is a new async method that enqueues a
 *     JOB_LISTING_GENERATE job to ai:standard and returns { jobId, estimatedMs }.
 *     The client polls GET /ai/jobs/:jobId to retrieve the AI-generated content.
 *
 *  3. generateHooks() similarly enqueues to ai:standard queue.
 *
 *  4. AiMediaService dependency removed — all AI calls now route through the
 *     queue → Worker → AiOrchestrator pipeline, satisfying the rule that
 *     NO service calls AI providers directly.
 *
 * Architecture:
 *  Controller
 *    → ProductsService.generateListing()
 *      → AiJobService.createJob('standard', JOB_LISTING_GENERATE)
 *        → AiStandardProcessor
 *          → AiOrchestratorService.resolve()
 *            → Cache / Memory / Router / Provider / BOT Fallback
 */

import {
  Injectable, Inject, NotFoundException, Logger,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { scoreProduct, RawProductSignals } from './engines/scoring.engine';
import { makeDecision } from './engines/decision.engine';
import { TrendFetcher } from './engines/trend.fetcher';
import { AuditService } from '../audit/audit.service';
import { ShopifyAutoListingService } from '../shopify/shopify-auto-listing.service';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { AiJobService } from '../workers/ai-job.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ScoreProductDto } from './dto/score-product.dto';
import {
  JOB_LISTING_GENERATE,
  JOB_MEDIA_GENERATE,
  JOB_HOOKS_GENERATE,
} from '../workers/queue.constants';

// Estimated queue latencies by tier — returned to caller for UI feedback
const QUEUE_ESTIMATED_MS: Record<string, number> = {
  critical:   2_000,
  standard:   5_000,
  background: 15_000,
};

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @Inject(DB_TOKEN) private db: NodePgDatabase<typeof schema>,
    private trendFetcher:       TrendFetcher,
    private audit:              AuditService,
    private shopifyAutoListing: ShopifyAutoListingService,
    private metaAds:            MetaAdsService,
    private jobService:         AiJobService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async createProduct(userId: string, dto: CreateProductDto) {
    const [product] = await this.db
      .insert(schema.products)
      .values({
        userId,
        title:         dto.title,
        description:   dto.description,
        supplierPrice: String(dto.supplierPrice),
        sellingPrice:  dto.estimatedSellingPrice
          ? String(dto.estimatedSellingPrice)
          : null,
        supplierType: dto.supplierType ?? 'mock',
        externalId:   dto.externalId,
        category:     dto.category,
        tags:         dto.tags ?? [],
        imageUrls:    dto.imageUrls ?? [],
      })
      .returning();

    return product;
  }

  async listProducts(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return this.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.userId, userId))
      .orderBy(desc(schema.products.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getProduct(userId: string, productId: string) {
    const [product] = await this.db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.id, productId),
          eq(schema.products.userId, userId),
        ),
      )
      .limit(1);

    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  // ── Scoring + Decision ───────────────────────────────────────────────────

  /**
   * scoreAndDecide (V2 — non-blocking AI calls)
   *
   * Scoring is deterministic (BOT tier) — no AI quota consumed.
   * AI media generation is enqueued to ai:background so this method
   * always returns in < 200ms regardless of AI provider availability.
   *
   * Returns: { product, mediaJobId }
   *   mediaJobId is only present when decision === 'RUN_ADS'
   */
  async scoreAndDecide(
    userId:     string,
    productId:  string,
    overrides?: ScoreProductDto,
  ): Promise<{
    product:    typeof schema.products.$inferSelect;
    mediaJobId: string | null;
  }> {
    const product = await this.getProduct(userId, productId);

    const sellingPrice =
      overrides?.estimatedSellingPrice ??
      (product.sellingPrice
        ? parseFloat(product.sellingPrice)
        : parseFloat(product.supplierPrice) * 2.5);

    const trendIndex = await this.trendFetcher.fetchTrendIndex(product.title);

    const signals: RawProductSignals = {
      supplierPrice:         parseFloat(product.supplierPrice),
      estimatedSellingPrice: sellingPrice,
      demandSearchVolume:    overrides?.demandSearchVolume ?? 1_000,
      competitorCount:       overrides?.competitorCount   ?? 50,
      reviewRating:          4.0,
      trendIndex,
    };

    const scoring              = scoreProduct(signals);
    const { decision, reason } = makeDecision(scoring);

    const [updated] = await this.db
      .update(schema.products)
      .set({
        demandScore:      String(scoring.demandScore),
        competitionScore: String(scoring.competitionScore),
        marginScore:      String(scoring.marginScore),
        trendIndex:       String(scoring.trendIndex),
        compositeScore:   String(scoring.compositeScore),
        decision,
        decisionReason:   reason,
        status:           'scored',
        scoredAt:         new Date(),
        sellingPrice:     String(sellingPrice),
      })
      .where(eq(schema.products.id, productId))
      .returning();

    await this.audit.log({
      tenantId: 'system',
      actorId: userId ?? 'system',
      action:     decision === 'REJECT' ? 'product.rejected' : 'product.scored',
      resource: 'products',
      severity: 'info' as const,
    });

    this.logger.log(
      `Product ${productId} scored: ${scoring.compositeScore} -> ${decision}`,
    );

    // ── Async side effects (fire-and-forget, never blocks response) ────────

    // Auto-list to Shopify (RUN_ADS only)
    void this.shopifyAutoListing.autoListIfEligible(userId, updated);

    // Auto-launch Meta Ads (RUN_ADS or TEST_ADS)
    void this.metaAds.autoLaunchIfEligible(userId, updated);

    // ── V2: Enqueue AI media generation via background queue ───────────────
    // CRITICAL: Never calls AI provider directly.
    // Routes: Controller -> scoreAndDecide -> AiJobService.createJob()
    //   -> ai:background queue -> AiBackgroundProcessor
    //     -> AiOrchestratorService.resolve() -> Cache/BOT/49B
    let mediaJobId: string | null = null;

    if (decision === 'RUN_ADS') {
      try {
        const { jobId } = await this.jobService.createJob({
          userId,
          queue:     'background',
          jobName:   JOB_MEDIA_GENERATE,
          operation: 'media',
          context: {
            title:         updated.title,
            category:      updated.category,
            tags:          updated.tags,
            description:   updated.description,
            imageUrls:     updated.imageUrls,
            supplierPrice: updated.supplierPrice,
            sellingPrice:  updated.sellingPrice,
            productId,
          },
        });

        mediaJobId = jobId;

        this.logger.log(
          `AI media job enqueued for product ${productId}: jobId=${jobId}`,
        );
      } catch (err) {
        // Non-critical — media generation failure must never crash scoring
        this.logger.error(
          `Failed to enqueue media job for product ${productId}: ` +
          `${(err as Error).message}`,
        );
      }
    }

    return { product: updated, mediaJobId };
  }

  // ── AI Listing Generation (async, job-based) ─────────────────────────────

  /**
   * generateListing — V2 async listing generation
   *
   * Enqueues a listing:generate job to ai:standard queue.
   * Returns immediately with { jobId, estimatedMs } — HTTP 202.
   * Client polls GET /ai/jobs/:jobId for the AI-generated listing:
   *   { title: "...", description: "...", tags: [...] }
   *
   * Routing (enforced by AiRouter, never overridable here):
   *  - compositeScore >= 65       -> NVIDIA 49B (cache-first)
   *  - pro/enterprise user        -> NVIDIA 49B (cache-first)
   *  - Circuit breaker open       -> BOT fallback (instant, $0)
   *  - No API key configured      -> BOT fallback (instant, $0)
   *  - Cache hit                  -> Returned from cache (< 5ms, $0)
   */
  async generateListing(
    userId:    string,
    productId: string,
    userTier?: 'free' | 'starter' | 'pro' | 'enterprise',
  ): Promise<{ jobId: string; estimatedMs: number }> {
    const product = await this.getProduct(userId, productId);

    const productScore = product.compositeScore
      ? parseFloat(String(product.compositeScore))
      : 0;

    const { jobId } = await this.jobService.createJob({
      userId,
      queue:        'standard',
      jobName:      JOB_LISTING_GENERATE,
      operation:    'listing',
      context: {
        title:          product.title,
        description:    product.description,
        category:       product.category,
        tags:           product.tags,
        supplierPrice:  product.supplierPrice,
        sellingPrice:   product.sellingPrice,
        compositeScore: product.compositeScore,
        decision:       product.decision,
        productId,
      },
      productScore,
      userTier,
    });

    this.logger.log(
      `Listing job enqueued for product ${productId}: jobId=${jobId} ` +
      `score=${productScore} tier=${userTier ?? 'free'}`,
    );

    return {
      jobId,
      estimatedMs: QUEUE_ESTIMATED_MS['standard'],
    };
  }

  // ── AI Hooks Generation (async, job-based) ───────────────────────────────

  /**
   * generateHooks — V2 async hook generation
   *
   * Enqueues a hooks:generate job to ai:standard queue.
   * Client polls GET /ai/jobs/:jobId for { hooks: string[] }.
   */
  async generateHooks(
    userId:    string,
    productId: string,
    userTier?: 'free' | 'starter' | 'pro' | 'enterprise',
  ): Promise<{ jobId: string; estimatedMs: number }> {
    const product = await this.getProduct(userId, productId);

    const { jobId } = await this.jobService.createJob({
      userId,
      queue:        'standard',
      jobName:      JOB_HOOKS_GENERATE,
      operation:    'hooks',
      context: {
        title:          product.title,
        category:       product.category,
        sellingPrice:   product.sellingPrice,
        decision:       product.decision,
        compositeScore: product.compositeScore,
        productId,
      },
      productScore: product.compositeScore
        ? parseFloat(String(product.compositeScore))
        : 0,
      userTier,
    });

    return { jobId, estimatedMs: QUEUE_ESTIMATED_MS['standard'] };
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteProduct(userId: string, productId: string): Promise<void> {
    const product = await this.getProduct(userId, productId);
    await this.db
      .delete(schema.products)
      .where(eq(schema.products.id, product.id));
  }
}
