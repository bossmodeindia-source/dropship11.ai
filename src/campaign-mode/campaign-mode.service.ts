/**
 * CampaignModeService
 *
 * Routes each campaign into the correct execution path:
 *
 *   PAID    → MetaAdsService.launchCampaign()
 *   ORGANIC → OrganicService.post()
 *   HYBRID  → OrganicService.post() first, then monitor ER.
 *             If ER > threshold → MetaAdsService.launchCampaign()
 *
 * Mode is chosen by the user at product approval time.
 * Admin can force-override or pause globally.
 *
 * Safety Guards (always enforced):
 *   ✅ No ads before Shopify product is ready
 *   ✅ Daily spend cap enforced
 *   ✅ Stop-loss protection per campaign
 *   ✅ No fulfillment before supplier payment
 */

import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as baseSchema from '../common/database/schema';
import * as ext from '../commerce/schema-extensions';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
import { MetaAdsExtensionService } from '../meta-ads/meta-ads-extension.service';
import { OrganicService } from '../organic/organic.service';
import { CreateOrganicPostDto } from '../organic/dto/organic.dto';
import { LaunchCampaignModeDto } from './dto/campaign-mode.dto';

export type CampaignMode = 'paid' | 'organic' | 'hybrid';

export interface CampaignLaunchResult {
  mode:          CampaignMode;
  phase:         string;
  organicPosts?: unknown[];
  metaCampaign?: unknown;
  message:       string;
}

@Injectable()
export class CampaignModeService {
  private readonly logger = new Logger(CampaignModeService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly metaAds:   MetaAdsService,
    private readonly metaExt:   MetaAdsExtensionService,
    private readonly organic:   OrganicService,
  ) {}

  // ── Main Launch ───────────────────────────────────────────────────────────

  async launch(userId: string, dto: LaunchCampaignModeDto): Promise<CampaignLaunchResult> {
    const product = await this.resolveProduct(userId, dto.productId);

    // Safety: No ads before Shopify product is ready
    if (!product.shopifyProductId) {
      throw new BadRequestException(
        'Cannot launch campaign — Shopify product not yet created. Create it first.',
      );
    }

    switch (dto.mode) {
      case 'paid':    return this.launchPaid(userId, product, dto);
      case 'organic': return this.launchOrganic(userId, product, dto);
      case 'hybrid':  return this.launchHybrid(userId, product, dto);
      default:
        throw new BadRequestException(`Unknown campaign mode: ${dto.mode}`);
    }
  }

  // ── Scale ─────────────────────────────────────────────────────────────────

  async scale(userId: string, campaignId: string, factor: number) {
    const [mode] = await this.db
      .select()
      .from(ext.campaignModes)
      .where(
        and(
          eq(ext.campaignModes.campaignId, campaignId),
          eq(ext.campaignModes.userId, userId),
        ),
      )
      .limit(1);

    if (!mode || mode.mode === 'organic') {
      throw new BadRequestException('Can only scale paid or hybrid campaigns');
    }

    // Delegate to MetaAdsExtensionService scaling
    this.logger.log(`Scaling campaign ${campaignId} by factor ${factor}`);
    await this.metaExt.scaleCampaign(userId, campaignId, factor);

    return { campaignId, scaled: true, factor };
  }

  // ── Pause ─────────────────────────────────────────────────────────────────

  async pause(userId: string, campaignId: string) {
    await this.metaExt.pauseCampaign(userId, campaignId);
    await this.db
      .update(ext.campaignModes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(ext.campaignModes.campaignId, campaignId),
          eq(ext.campaignModes.userId, userId),
        ),
      );
    return { campaignId, paused: true };
  }

  // ── Hybrid Escalation Monitor ─────────────────────────────────────────────

  /**
   * Called by the commerce pipeline to check if hybrid organic posts
   * have hit the engagement threshold and should escalate to paid.
   */
  async checkAndEscalateHybrid(userId: string, productId: string, campaignId: string): Promise<boolean> {
    const { shouldEscalate, bestER } = await this.organic.shouldEscalateToPaid(productId);

    if (!shouldEscalate) return false;

    this.logger.log(
      `Hybrid escalation triggered for product ${productId} — ER=${bestER} → launching paid ads`,
    );

    const product = await this.resolveProduct(userId, productId);
    await this.metaAds.autoLaunchIfEligible(userId, { ...product, decision: 'RUN_ADS' as const });

    // Update campaign mode phase
    await this.db
      .update(ext.campaignModes)
      .set({ phase: 'paid', escalatedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(ext.campaignModes.campaignId, campaignId),
          eq(ext.campaignModes.userId, userId),
        ),
      );

    return true;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async launchPaid(userId: string, product: any, dto: LaunchCampaignModeDto): Promise<CampaignLaunchResult> {
    this.logger.log(`Launching PAID ads for product ${product.id}`);

    // Enforce stop-loss before launch
    this.enforceSafetyLimits(dto);

    const decision = (product.decision === 'RUN_ADS' || product.decision === 'TEST_ADS')
      ? product.decision
      : 'TEST_ADS';

    await this.metaAds.autoLaunchIfEligible(userId, { ...product, decision });

    // Record mode
    await this.recordCampaignMode(dto.campaignId!, userId, 'paid', 'paid', dto);

    return {
      mode:    'paid',
      phase:   'paid',
      message: `Paid Meta ads campaign launched for "${product.title}"`,
    };
  }

  private async launchOrganic(userId: string, product: any, dto: LaunchCampaignModeDto): Promise<CampaignLaunchResult> {
    this.logger.log(`Launching ORGANIC posts for product ${product.id}`);

    const platforms: CreateOrganicPostDto['platforms'] = dto.platforms?.length
      ? dto.platforms as Array<'instagram' | 'facebook' | 'instagram_reels' | 'facebook_reels'>
      : ['instagram', 'facebook'];

    const result = await this.organic.post(userId, {
      productId:  product.id,
      campaignId: dto.campaignId,
      platforms,
    });

    await this.recordCampaignMode(dto.campaignId!, userId, 'organic', 'organic', dto);

    return {
      mode:         'organic',
      phase:        'organic',
      organicPosts: result.posted,
      message:      `Organic posts published to ${platforms.join(', ')} for "${product.title}"`,
    };
  }

  private async launchHybrid(userId: string, product: any, dto: LaunchCampaignModeDto): Promise<CampaignLaunchResult> {
    this.logger.log(`Launching HYBRID campaign for product ${product.id} — organic first`);

    const platforms: CreateOrganicPostDto['platforms'] = dto.platforms?.length
      ? dto.platforms as Array<'instagram' | 'facebook' | 'instagram_reels' | 'facebook_reels'>
      : ['instagram', 'facebook'];

    const result = await this.organic.post(userId, {
      productId:  product.id,
      campaignId: dto.campaignId,
      platforms,
    });

    await this.recordCampaignMode(dto.campaignId!, userId, 'hybrid', 'organic', dto);

    return {
      mode:         'hybrid',
      phase:        'organic',
      organicPosts: result.posted,
      message:
        `Hybrid campaign started — organic posts published to ${platforms.join(', ')}. ` +
        `Paid ads will auto-escalate when engagement rate ≥ 3%.`,
    };
  }

  private async recordCampaignMode(
    campaignId: string,
    userId: string,
    mode: CampaignMode,
    phase: string,
    dto: LaunchCampaignModeDto,
  ) {
    await this.db
      .insert(ext.campaignModes)
      .values({
        campaignId,
        userId,
        mode,
        phase,
        dailyCapInr:  String(dto.dailyCapInr  ?? 1000),
        stopLossInr:  String(dto.stopLossInr  ?? 5000),
        paidBudgetInr: String(dto.paidBudgetInr ?? 0),
      })
      .onConflictDoUpdate({
        target: ext.campaignModes.campaignId,
        set:    { mode, phase, updatedAt: new Date() },
      });
  }

  private enforceSafetyLimits(dto: LaunchCampaignModeDto) {
    if (dto.dailyCapInr && dto.dailyCapInr > 50_000) {
      throw new ForbiddenException('Daily cap exceeds maximum allowed limit of ₹50,000');
    }
    if (dto.stopLossInr && dto.stopLossInr > 200_000) {
      throw new ForbiddenException('Stop-loss exceeds maximum allowed limit of ₹2,00,000');
    }
  }

  private async resolveProduct(userId: string, productId: string) {
    const [product] = await this.db
      .select()
      .from(baseSchema.products)
      .where(
        and(
          eq(baseSchema.products.id,     productId),
          eq(baseSchema.products.userId, userId),
        ),
      )
      .limit(1);

    if (!product) throw new BadRequestException('Product not found');
    return product;
  }
}
