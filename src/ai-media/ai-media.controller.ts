/**
 * AiMediaController
 *
 * Exposes all AI media generation capabilities from the Open Generative AI
 * layer as authenticated REST endpoints.
 *
 * API KEY POLICY: The Muapi.ai API key is a permanent server-side secret
 * (AI_MEDIA_API_KEY in .env). It is NEVER accepted from or exposed to users.
 * All endpoints are JWT-protected — users authenticate via the app's own
 * auth system, not via any third-party AI key.
 */
import {
  Controller, Post, Get, Body, Param, UseGuards,
  ParseUUIDPipe, HttpCode, HttpStatus,
  UploadedFile, UseInterceptors,
  BadRequestException, Inject, NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags, ApiOperation, ApiBearerAuth, ApiParam,
  ApiConsumes, ApiBody,
} from '@nestjs/swagger';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AiMediaService } from './ai-media.service';
import {
  GenerateImageDto,
  GenerateI2IDto,
  GenerateVideoDto,
  GenerateI2VDto,
  GenerateV2VDto,
  LipSyncDto,
  GenerateAdMediaDto,
} from './dto/generate-media.dto';

@ApiTags('ai-media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai-media')
export class AiMediaController {
  constructor(
    private readonly aiMedia: AiMediaService,
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ── Text-to-Image ─────────────────────────────────────────────────────────

  /**
   * POST /ai-media/image
   *
   * Generate an image from a text prompt.
   * 50+ models available — defaults to flux-schnell-image.
   */
  @Post('image')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate image from text prompt (T2I)',
    description:
      'Generates a product/ad image using 50+ text-to-image models. ' +
      'No API key required — the platform key is used automatically.',
  })
  generateImage(
    @CurrentUser() _user: JwtPayload,
    @Body() dto: GenerateImageDto,
  ) {
    return this.aiMedia.generateI2I({
      prompt:       dto.prompt,
      model: dto.model ?? undefined,
      quality:      dto.quality,
      resolution:   dto.resolution,
    });
  }

  // ── Image-to-Image ────────────────────────────────────────────────────────

  /**
   * POST /ai-media/image-to-image
   *
   * Transform or edit an existing image using a reference.
   * Supports multi-image models (up to 14 references via imagesList).
   * 55+ models available — defaults to flux-kontext-dev-i2i.
   */
  @Post('image-to-image')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Transform image using reference(s) (I2I)',
    description:
      'Edit or stylise an image using 1–14 reference images. ' +
      'Multi-image models (Nano Banana 2 Edit, Flux Kontext) accept imagesList.',
  })
  generateI2I(
    @CurrentUser() _user: JwtPayload,
    @Body() dto: GenerateI2IDto,
  ) {
    return this.aiMedia.generateI2I({
      prompt:       dto.prompt,
      model: dto.model ?? undefined,
      quality:      dto.quality,
      resolution:   dto.resolution,
    });
  }

  // ── Text-to-Video ─────────────────────────────────────────────────────────

  /**
   * POST /ai-media/video
   *
   * Generate a video from a text prompt.
   * 40+ models available — defaults to seedance-lite-t2v.
   * Note: video generation can take several minutes for high-quality models.
   */
  @Post('video')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate video from text prompt (T2V)',
    description:
      'Generates a short-form ad video. 40+ models including Kling, Sora, Veo, ' +
      'Seedance, Wan, Runway. Vertical 9:16 default for social media.',
  })
  generateVideo(
    @CurrentUser() _user: JwtPayload,
    @Body() dto: GenerateVideoDto,
  ) {
    return this.aiMedia.generateI2V({
      prompt:       dto.prompt,
      model: dto.model ?? undefined,
      resolution: dto.aspectRatio,
      duration:     dto.duration,
      quality:      dto.quality,
      mode:         dto.mode,
    });
  }

  // ── Image-to-Video ────────────────────────────────────────────────────────

  /**
   * POST /ai-media/image-to-video
   *
   * Animate a product image into a short video.
   * Ideal for product listings: feed the product's main photo as imageUrl.
   * 60+ models available — defaults to kling-v2-1-i2v-standard.
   */
  @Post('image-to-video')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Animate a product image into a video (I2V)',
    description:
      'Turns a still product image into a dynamic ad video. 60+ models including ' +
      'Kling I2V, Veo3 I2V, Runway I2V, Seedance 2.0 I2V, Midjourney I2V.',
  })
  generateI2V(
    @CurrentUser() _user: JwtPayload,
    @Body() dto: GenerateI2VDto,
  ) {
    return this.aiMedia.generateI2V({
      prompt:       dto.prompt,
      model: dto.model ?? undefined,
      resolution: dto.aspectRatio,
      duration:     dto.duration,
      quality:      dto.quality,
    });
  }

  // ── Video-to-Video ────────────────────────────────────────────────────────

  /**
   * POST /ai-media/video-to-video
   *
   * Process an existing video (background removal, watermark removal, etc.).
   */
  @Post('video-to-video')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Process an existing video (V2V)',
    description: 'Apply transformations to existing videos — background removal, watermark removal, etc.',
  })
  generateV2V(
    @CurrentUser() _user: JwtPayload,
    @Body() dto: GenerateV2VDto,
  ) {
    return this.aiMedia.generateV2V({
      prompt: (dto as { prompt?: string }).prompt ?? '',
      videoUrl: dto.videoUrl,
      model: dto.model ?? undefined,
    });
  }

  // ── Lip Sync ──────────────────────────────────────────────────────────────

  /**
   * POST /ai-media/lipsync
   *
   * Generate a lip-synced talking-head video.
   *
   * Mode A (portrait): provide imageUrl + audioUrl  → animated talking video
   * Mode B (video):    provide videoUrl + audioUrl  → lipsync overlay
   *
   * 9 dedicated models — defaults to ltx-2-3-lipsync.
   */
  @Post('lipsync')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate lip-synced talking video',
    description:
      'Mode A: portrait image + audio → animated talking head video. ' +
      'Mode B: existing video + audio → lipsync overlay. ' +
      '9 models: LTX, Infinite Talk, Wan 2.2, Sync, LatentSync, Creatify, Veed.',
  })
  processLipSync(
    @CurrentUser() _user: JwtPayload,
    @Body() dto: LipSyncDto,
  ) {
    if (!dto.imageUrl && !dto.videoUrl) {
      throw new BadRequestException(
        'Either imageUrl (portrait mode) or videoUrl (video-lipsync mode) is required',
      );
    }
    return this.aiMedia.processLipSync({
      audioUrl: dto.audioUrl,
      imageUrl: dto.imageUrl,
      videoUrl: dto.videoUrl,
      prompt:     dto.prompt,
      model: dto.model ?? undefined,
    });
  }

  // ── File Upload ───────────────────────────────────────────────────────────

  /**
   * POST /ai-media/upload
   *
   * Upload an image, video, or audio file to the muapi CDN.
   * Returns a hosted URL you can pass into I2I, I2V, or LipSync requests.
   */
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'File to upload (image, video, or audio)',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload a file to the media CDN',
    description:
      'Upload an image/video/audio file and get back a hosted URL. ' +
      'Use the returned URL as imageUrl, videoUrl, or audioUrl in generation requests.',
  })
  async uploadFile(
    @CurrentUser() _user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided — include a "file" field in the multipart body');
    }
    const url = (await this.aiMedia.uploadFile(file as Express.Multer.File)).url;
    return { url: url, filename: file.originalname, mimeType: file.mimetype };
  }

  // ── Product ad-media bundle ───────────────────────────────────────────────

  /**
   * POST /ai-media/product-bundle
   *
   * Generate both an image + video ad bundle for a product in one call.
   * Prompts are auto-built from the product's title, category, and tags.
   * Results are cached per product — repeat calls return instantly from cache.
   */
  @Post('product-bundle')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate image + video ad bundle for a product',
    description:
      'Auto-generates prompts from product metadata and produces both an image ' +
      'and a video ad. Caches results — repeat calls for the same product return ' +
      'from DB with zero API cost.',
  })
  async generateAdBundle(
    @CurrentUser() user: JwtPayload,
    @Body() dto: GenerateAdMediaDto,
  ) {
    // Inline type to avoid heavy DB import in controller
    const product = await this.resolveProduct(dto.productId, user.sub);
    return this.aiMedia.generateAdMedia(
      product,
      dto.campaignId,
      dto.imageModel,
      dto.videoModel,
    );
  }

  /**
   * GET /ai-media/product/:productId/best
   *
   * Returns the best-performing cached creative for a product.
   * Zero API calls — pure DB lookup.
   */
  @Get('product/:productId/best')
  @ApiOperation({
    summary: 'Get the best cached creative for a product',
    description: 'Returns the highest-use-count cached image+video pair. No API call.',
  })
  @ApiParam({ name: 'productId', type: String })
  getBestCreative(
    @CurrentUser() _user: JwtPayload,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.aiMedia.getBestCreative(productId);
  }

  /**
   * POST /ai-media/product/:productId/animate
   *
   * Shortcut: animate the product's own first image into a video.
   * Pulls imageUrls[0] from the product row — no imageUrl needed in the body.
   * Ideal for one-click "make this product video" from the product listing page.
   */
  @Post('product/:productId/animate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Animate a product\'s own image into a video (one-click I2V)',
    description:
      'Fetches the product\'s first imageUrl and passes it through Image-to-Video. ' +
      'No imageUrl needed in the request body — it comes straight from the product row.',
  })
  @ApiParam({ name: 'productId', type: String })
  async animateProduct(
    @CurrentUser() user: JwtPayload,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: GenerateI2VDto,
  ) {
    const product = await this.resolveProduct(productId, user.sub);

    const imageUrl =
      (product.imageUrls as string[] | undefined)?.[0] ?? dto.imageUrl;

    if (!imageUrl) {
      throw new BadRequestException(
        'Product has no imageUrls — provide imageUrl in the request body or upload a product image first',
      );
    }

    return this.aiMedia.generateI2V({
      imageUrl:    imageUrl,
      prompt:       dto.prompt,
      model: dto.model ?? undefined,
      resolution: dto.aspectRatio ?? '9:16',
      duration:     dto.duration    ?? 10,
      quality:      dto.quality,
    });
  }

  /**
   * POST /ai-media/product/:productId/edit-image
   *
   * Shortcut: run I2I on the product's own first image.
   * Useful for background removal, upscaling, or style transfer
   * directly from the product page.
   */
  @Post('product/:productId/edit-image')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Edit a product\'s own image via Image-to-Image (one-click I2I)',
    description:
      'Fetches the product\'s first imageUrl and transforms it with the selected I2I model. ' +
      'Common uses: background removal, upscaling, style transfer.',
  })
  @ApiParam({ name: 'productId', type: String })
  async editProductImage(
    @CurrentUser() user: JwtPayload,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: GenerateI2IDto,
  ) {
    const product = await this.resolveProduct(productId, user.sub);

    const imageUrl =
      (product.imageUrls as string[] | undefined)?.[0] ?? dto.imageUrl;

    if (!imageUrl) {
      throw new BadRequestException(
        'Product has no imageUrls — provide imageUrl in the request body or upload a product image first',
      );
    }

    return this.aiMedia.generateI2I({
      imageUrl:    imageUrl,
      prompt:       dto.prompt,
      model: dto.model ?? undefined,
      resolution: dto.aspectRatio ?? '1:1',
      quality:      dto.quality,
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Fetch product from DB, enforcing user ownership. */
  private async resolveProduct(productId: string, userId: string) {
    const product = await this.db.query.products.findFirst({
      where: and(
        eq(schema.products.id,     productId),
        eq(schema.products.userId, userId),
      ),
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
}
