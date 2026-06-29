import {
  Controller, Post, Get,
  Body, Param, UseGuards,
  ParseUUIDPipe, HttpCode, HttpStatus,
  Inject, NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  ApiTags, ApiOperation, ApiBearerAuth, ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AdCreativesService } from './ad-creatives.service';
import { CreativeGeneratorService } from './creative-generator.service';
import { GenerateCreativesDto } from './dto/generate-creatives.dto';

@ApiTags('ad-creatives')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ad-creatives')
export class AdCreativesController {
  constructor(
    private readonly adCreatives: AdCreativesService,
    private readonly generator:   CreativeGeneratorService,
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * POST /ad-creatives/generate
   * Generate a full creative bundle (hooks + captions + headlines + video
   * script) for a product and persist it to `ad_creative_assets`.
   */
  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate & store a full AI creative bundle for a product' })
  generate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: GenerateCreativesDto,
  ) {
    return this.adCreatives.generateForProduct(
      user.sub,
      dto.productId,
      dto.campaignId ?? null,
    );
  }

  /**
   * POST /ad-creatives/preview
   * Generate a live preview bundle without persisting to DB.
   * Useful for front-end previewing before launching a campaign.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Preview a creative bundle (no DB write)' })
  async preview(
    @CurrentUser() user: JwtPayload,
    @Body() dto: GenerateCreativesDto,
  ) {
    const product = await this.db.query.products.findFirst({
      where: and(
        eq(schema.products.id,     dto.productId),
        eq(schema.products.userId, user.sub),
      ),
    });

    if (!product) throw new NotFoundException('Product not found');

    const [hooks, captions, headlines, videoScript] = await Promise.all([
      this.generator.generateHooks(product),
      this.generator.generateAdCopy(product),
      this.generator.generateHeadlines(product),
      this.generator.generateVideoScript(product),
    ]);

    return { productId: product.id, hooks, captions, headlines, videoScript };
  }

  /**
   * GET /ad-creatives/product/:productId
   * List all previously generated creative bundles for a product.
   */
  @Get('product/:productId')
  @ApiOperation({ summary: 'List creative bundles for a product' })
  @ApiParam({ name: 'productId', type: String })
  findByProduct(
    @CurrentUser() user: JwtPayload,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.adCreatives.findByProduct(user.sub, productId);
  }

  /**
   * GET /ad-creatives/campaign/:campaignId
   * List all creative bundles attached to a campaign.
   */
  @Get('campaign/:campaignId')
  @ApiOperation({ summary: 'List creative bundles for a campaign' })
  @ApiParam({ name: 'campaignId', type: String })
  findByCampaign(
    @CurrentUser() user: JwtPayload,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ) {
    return this.adCreatives.findByCampaign(user.sub, campaignId);
  }

  /**
   * GET /ad-creatives/:id
   * Get a single creative bundle by ID.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a single creative bundle by ID' })
  @ApiParam({ name: 'id', type: String })
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adCreatives.findOne(user.sub, id);
  }
}
