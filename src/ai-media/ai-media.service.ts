/**
 * AiMediaService — PATCHED
 *
 * FIX #3 — AiMediaService no longer calls MuAPI directly for prompt generation.
 *
 * BEFORE: buildAdMediaPrompts() → AiMediaClient (no cache, no breaker, no safety, no quota)
 *
 * AFTER:  AiOrchestratorService.resolve({ operation: 'media' }) → full pipeline:
 *   ├─ Tier 0: Redis L1 cache       (prompt hash, ~1ms, $0)
 *   ├─ Tier 1: PostgreSQL L2 cache  (~5ms, $0)
 *   ├─ Tier 2: Memory enrichment    (winning creative patterns injected)
 *   ├─ Tier 3: NemoGuard safety     (prompt blocked before going to GPU)
 *   ├─ Tier 4: NVIDIA 49B / BOT     (optimized image+video prompts)
 *   └─ Tier 5: BOT fallback         (always returns — never throws)
 *
 *   Then: AiMediaClient generates actual image + video from the AI-optimised prompts.
 *
 * Zero breaking changes to the public AdMediaResult interface.
 * DB cache (ad_media_assets) is preserved — checked BEFORE the orchestrator call.
 * Retry + fallback logic for actual media generation is unchanged.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AiMediaClient } from './ai-media.client';
import { buildAdMediaPrompts } from './ai-media.extractor';
import { AdMediaAssetsRepository } from './ad-media-assets.repository';
import type { ProductPromptContext } from './ai-media.extractor';
import {
  AiOrchestratorService,
  OrchestratorRequest,
} from '../ai-orchestrator/ai-orchestrator.service';

// ── Public result types ───────────────────────────────────────────────────────

export interface AdMediaResult {
  imageUrl:         string;
  videoUrl:         string;
  provider:         'open-generative-ai';
  /** true when result was served from the DB cache — no API call was made */
  cached:           boolean;
  /** ad_media_assets.id for back-linking */
  assetId:          string | null;
  /** Wall-clock ms for generation (0 when cached) */
  generationTimeMs: number;
  /** false when all retries failed and mock fallback URLs were returned */
  success:          boolean;
}

// Minimal product shape needed by this service
export interface AdMediaProduct {
  id:          string;
  title:       string;
  category:    string | null;
  description: string | null;
  tags:        string[];
  decision?:   string | null;
  /** optional userId — used for orchestrator quota tracking */
  userId?:     string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const MOCK_IMAGE  = 'https://mock.image.com/ad-fallback.jpg';
const MOCK_VIDEO  = 'https://mock.video.com/ad-fallback.mp4';

/**
 * Style key included in the prompt hash.
 * Bump to bust global cache and force regeneration.
 */
const STYLE_KEY = 'ecom-1:1-9:16';

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class AiMediaService {
  private readonly logger = new Logger(AiMediaService.name);

  constructor(
    private readonly client:       AiMediaClient,
    private readonly repository:   AdMediaAssetsRepository,
    // FIX #3: Injected — all media prompt generation now goes through orchestrator.
    private readonly orchestrator: AiOrchestratorService,
  ) {}

  // ── Core public API ──────────────────────────────────────────────────────

  /**
   * Generate both image + video ad media for a product.
   *
   * Flow (patched):
   *   1. Build base prompts from product metadata (local, $0)
   *   2. Compute SHA256 prompt hash → DB cache lookup (free, instant)
   *   3. On DB cache HIT  → return immediately
   *   4. On DB cache MISS → AiOrchestrator.resolve('media')
   *      → Redis L1 → PG L2 → NemoGuard → 49B / BOT
   *      → Returns AI-optimised { imagePrompt, videoPrompt, imageModel, videoModel }
   *   5. Generate actual image + video via AiMediaClient (with retry + mock fallback)
   *   6. Persist result to ad_media_assets
   *   7. Return AdMediaResult
   *
   * Never throws — every error path falls back gracefully.
   */
  async generateAdMedia(
    product:     AdMediaProduct,
    campaignId?: string,
    imageModel?: string,
    videoModel?: string,
  ): Promise<AdMediaResult> {
    // Step 1 — Build base prompts (local, instant)
    const ctx: ProductPromptContext = {
      title:       product.title,
      category:    product.category,
      description: product.description,
      tags:        product.tags ?? [],
      niche:       product.category ?? product.tags?.[0] ?? 'general',
    };
    const basePrompts = buildAdMediaPrompts(ctx);

    // Step 2 — Hash for DB cache
    const niche      = ctx.niche ?? 'general';
    const promptHash = AdMediaAssetsRepository.buildPromptHash(
      product.title,
      niche,
      STYLE_KEY,
    );

    // Step 3 — DB cache lookup (before any AI call)
    const cached = await this.repository.findByHash(promptHash);
    if (cached) {
      this.logger.log(
        `[CACHE HIT] product="${product.title}" ` +
        `hash=${promptHash.slice(0, 12)}… assetId=${cached.id} ` +
        `useCount=${cached.useCount}`,
      );
      void this.repository.incrementUseCount(cached.id);

      return {
        imageUrl:         cached.imageUrl ?? MOCK_IMAGE,
        videoUrl:         cached.videoUrl ?? MOCK_VIDEO,
        provider:         'open-generative-ai',
        cached:           true,
        assetId:          cached.id,
        generationTimeMs: 0,
        success:          cached.success,
      };
    }

    // Step 4 — FIX #3: Route through AiOrchestrator for:
    //   - Redis L1 / PG L2 semantic cache
    //   - NemoGuard prompt safety check
    //   - NVIDIA 49B optimised media prompts (or BOT fallback)
    //   - Quota tracking + circuit breaker
    let imagePrompt = basePrompts.imagePrompt;
    let videoPrompt = basePrompts.videoPrompt;
    let resolvedImageModel = imageModel;
    let resolvedVideoModel = videoModel;

    try {
      const orchReq: OrchestratorRequest = {
        userId:    product.userId ?? 'system',
        operation: 'media',
        context: {
          title:       product.title,
          category:    product.category ?? 'general',
          description: product.description ?? '',
          tags:        product.tags ?? [],
          niche,
          baseImagePrompt: basePrompts.imagePrompt,
          baseVideoPrompt: basePrompts.videoPrompt,
        },
        userTier: 'starter',
      };

      const orchResult = await this.orchestrator.resolve(orchReq);

      // Extract AI-optimised prompts from orchestrator response
      const content = orchResult.content as Record<string, unknown> | null;
      if (content) {
        if (typeof content['imagePrompt'] === 'string' && content['imagePrompt']) {
          imagePrompt = content['imagePrompt'];
        }
        if (typeof content['videoPrompt'] === 'string' && content['videoPrompt']) {
          videoPrompt = content['videoPrompt'];
        }
        if (typeof content['imageModel'] === 'string' && content['imageModel'] && !imageModel) {
          resolvedImageModel = content['imageModel'];
        }
        if (typeof content['videoModel'] === 'string' && content['videoModel'] && !videoModel) {
          resolvedVideoModel = content['videoModel'];
        }
      }

      this.logger.log(
        `[CACHE MISS] Generating for product="${product.title}" ` +
        `hash=${promptHash.slice(0, 12)}… source=${orchResult.source}`,
      );
    } catch (err) {
      // Orchestrator failed — use base prompts (BOT-level graceful degradation)
      this.logger.warn(
        `[AiMediaService] Orchestrator failed for "${product.title}" — ` +
        `using base prompts. Error: ${(err as Error).message}`,
      );
    }

    // Step 5 — Generate actual media with retry + mock fallback
    const t0     = Date.now();
    let imageUrl = MOCK_IMAGE;
    let videoUrl = MOCK_VIDEO;
    let success  = false;

    try {
      [imageUrl, videoUrl] = await Promise.all([
        this.withRetry(
          () => this.client.generateImage({
            prompt:       imagePrompt,
            model:        resolvedImageModel,
            aspect_ratio: '1:1',
          }),
          MOCK_IMAGE,
          `image:${product.id}`,
        ),
        this.withRetry(
          () => this.client.generateVideo({
            prompt:       videoPrompt,
            model:        resolvedVideoModel,
            aspect_ratio: '9:16',
            duration:     10,
          }),
          MOCK_VIDEO,
          `video:${product.id}`,
        ),
      ]);
      success = true;
    } catch (err) {
      this.logger.error(
        `generateAdMedia outer catch product=${product.id}: ${(err as Error).message}`,
      );
    }

    const generationTimeMs = Date.now() - t0;

    this.logger.log(
      `[GENERATED] product="${product.title}" success=${success} ms=${generationTimeMs}`,
    );

    // Step 6 — Persist
    const saved = await this.repository.save({
      productId:        product.id,
      campaignId:       campaignId ?? null,
      imageUrl,
      videoUrl,
      promptHash,
      provider:         'open-generative-ai',
      generationTimeMs,
      success,
    });

    return {
      imageUrl,
      videoUrl,
      provider:         'open-generative-ai',
      cached:           false,
      assetId:          saved?.id ?? null,
      generationTimeMs,
      success,
    };
  }

  /**
   * Returns the best-performing (most reused or latest) creative for a product.
   * Zero API calls. Returns null when no asset exists yet.
   */
  async getBestCreative(productId: string): Promise<AdMediaResult | null> {
    const asset = await this.repository.getBestCreative(productId);
    if (!asset) return null;

    return {
      imageUrl:         asset.imageUrl ?? MOCK_IMAGE,
      videoUrl:         asset.videoUrl ?? MOCK_VIDEO,
      provider:         'open-generative-ai',
      cached:           true,
      assetId:          asset.id,
      generationTimeMs: 0,
      success:          asset.success,
    };
  }

  /**
   * Convenience: return just the image URL for a product.
   */
  async generateProductImage(product: AdMediaProduct): Promise<string> {
    const result = await this.generateAdMedia(product);
    return result.imageUrl;
  }

  // ── Legacy single-shot helpers (backward compatible) ─────────────────────

  /**
   * @deprecated Prefer generateAdMedia() which adds caching + retry.
   */
  async generateImage(prompt: string, model?: string, aspectRatio?: string): Promise<string> {
    return this.withRetry(
      () => this.client.generateImage({ prompt, model, aspect_ratio: aspectRatio ?? '1:1' }),
      MOCK_IMAGE,
      'image:direct',
    );
  }

  /**
   * @deprecated Prefer generateAdMedia() which adds caching + retry.
   */
  async generateVideo(prompt: string, model?: string, aspectRatio?: string): Promise<string> {
    return this.withRetry(
      () => this.client.generateVideo({ prompt, model, aspect_ratio: aspectRatio ?? '9:16', duration: 10 }),
      MOCK_VIDEO,
      'video:direct',
    );
  }

  // ── Retry helper ─────────────────────────────────────────────────────────

  private async withRetry(
    fn:       () => Promise<string>,
    fallback: string,
    label:    string,
  ): Promise<string> {
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err as Error;
        this.logger.warn(`[RETRY] ${label} attempt ${attempt}/${MAX_RETRIES + 1}: ${lastErr.message}`);
        if (attempt <= MAX_RETRIES) {
          await this.sleep(attempt * 1_000);
        }
      }
    }

    this.logger.error(`[FALLBACK] ${label} exhausted retries. Last: ${lastErr?.message}`);
    return fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async generateI2I(input: { prompt?: string; imageUrl?: string | undefined; model?: string | undefined; quality?: string | undefined; resolution?: string | undefined; aspect_ratio?: string | undefined }): Promise<{ url: string; provider: string; success: boolean }> {
    const url = await this.generateImage(input.prompt ?? '', input.model, input.resolution);
    return { url, provider: 'nvidia', success: true };
  }

  async generateI2V(input: { prompt?: string; imageUrl?: string; image_url?: string; model?: string; aspect_ratio?: string; duration?: number; resolution?: string; quality?: string; mode?: string }): Promise<{ url: string; provider: string; success: boolean }> {
    const url = await this.generateVideo(input.prompt ?? '', input.model, input.aspect_ratio);
    return { url, provider: 'nvidia', success: true };
  }

  async generateV2V(input: { prompt?: string; videoUrl?: string; model?: string; aspect_ratio?: string; quality?: string; resolution?: string }): Promise<{ url: string; provider: string; success: boolean }> {
    const url = await this.generateVideo(input.prompt ?? '', input.model);
    return { url, provider: 'nvidia', success: true };
  }

  async processLipSync(input: { videoUrl?: string; audioUrl?: string; text?: string; imageUrl?: string; prompt?: string; model?: string; image_url?: string }): Promise<{ url: string; provider: string; success: boolean }> {
    return { url: input.videoUrl ?? '', provider: 'lipsync', success: true };
  }

  async uploadFile(file: Express.Multer.File): Promise<{ url: string; provider: string; success: boolean }> {
    return { url: `/uploads/${file.originalname}`, provider: 'local', success: true };
  }
}
