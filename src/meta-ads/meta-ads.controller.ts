import {
  Controller, Post, Get, Body, Param,
  ParseUUIDPipe, NotFoundException, BadRequestException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { MetaAdsService, AdsDecision } from './meta-ads.service';
import { LaunchMetaCampaignDto } from './dto/launch-meta-campaign.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

@ApiTags('meta-ads')
@ApiBearerAuth()
@Controller('meta-ads')
export class MetaAdsController {
  constructor(
    private readonly metaAds: MetaAdsService,
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * POST /meta-ads/launch
   * Manually trigger a Meta Ads campaign for a scored product.
   * Useful for re-launching, retrying errors, or testing without waiting
   * for the auto-trigger.
   */
  @Post('launch')
  @ApiOperation({ summary: 'Manually launch a Meta Ads campaign for a product' })
  async launch(
    @CurrentUser() user: JwtPayload,
    @Body() dto: LaunchMetaCampaignDto,
  ) {
    const product = await this.db.query.products.findFirst({
      where: and(
        eq(schema.products.id, dto.productId),
        eq(schema.products.userId, user.sub),
      ),
    });

    if (!product) throw new NotFoundException('Product not found');

    const decision: AdsDecision | null =
      dto.decision ??
      (product.decision === 'RUN_ADS' || product.decision === 'TEST_ADS'
        ? (product.decision as AdsDecision)
        : null);

    if (!decision) {
      throw new BadRequestException(
        `Product decision is "${product.decision}". ` +
        `Only RUN_ADS or TEST_ADS products can run Meta Ads.`,
      );
    }

    const result = await this.metaAds.launchCampaign(user.sub, product, decision);
    return { success: true, ...result };
  }

  /**
   * GET /meta-ads/product/:productId
   * List all Meta campaigns (with adsets + creatives) for a product.
   */
  @Get('product/:productId')
  @ApiOperation({ summary: 'Get Meta campaigns for a product' })
  findByProduct(
    @CurrentUser() user: JwtPayload,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.metaAds.findCampaignsByProduct(user.sub, productId);
  }

  /**
   * GET /meta-ads/campaign/:campaignId/adsets
   * List adsets (with creatives) for a Meta campaign.
   */
  @Get('campaign/:campaignId/adsets')
  @ApiOperation({ summary: 'Get adsets for a Meta campaign' })
  findAdSets(
    @CurrentUser() user: JwtPayload,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ) {
    return this.metaAds.findAdSetsByCampaign(user.sub, campaignId);
  }
}
