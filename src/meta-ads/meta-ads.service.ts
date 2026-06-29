/**
 * MetaAdsService — PATCHED v2 — FIX #2: duplicateAdSet is now real
 */ 
import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { MetaApiClient } from './meta-api.client';
import { CreativeGeneratorService } from '../ad-creatives/creative-generator.service';
import { AiMediaService } from '../ai-media/ai-media.service';

export type AdsDecision = 'RUN_ADS' | 'TEST_ADS';

type Product = typeof schema.products.$inferSelect;

interface BudgetRange { min: number; max: number }

const BUDGET: Record<AdsDecision, BudgetRange> = {
  RUN_ADS:  { min: 500,  max: 1500 },
  TEST_ADS: { min: 200,  max: 500  },
};

const OBJECTIVE: Record<AdsDecision, 'CONVERSIONS' | 'TRAFFIC'> = {
  RUN_ADS:  'CONVERSIONS',
  TEST_ADS: 'TRAFFIC',
};

const GOAL: Record<AdsDecision, string> = {
  RUN_ADS:  'OFFSITE_CONVERSIONS',
  TEST_ADS: 'LINK_CLICKS',
};

function randomBudget({ min, max }: BudgetRange): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildTargeting(product: Product): Record<string, unknown> {
  return {
    geo_locations:       { countries: ['IN'] },
    age_min:             18,
    age_max:             55,
    genders:             [0],
    flexible_spec: [
      {
        interests: [
          { id: '6003232518610', name: 'Online shopping' },
          { id: '6002925969459', name: 'Shopping' },
        ],
      },
    ],
    publisher_platforms: ['facebook', 'instagram'],
    device_platforms:    ['mobile', 'desktop'],
    product_category:    product.category ?? 'general',
  };
}

@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly metaApi:           MetaApiClient,
    private readonly creativeGenerator: CreativeGeneratorService,
    private readonly aiMedia:           AiMediaService,
  ) {}

  // ── Auto-trigger ─────────────────────────────────────────────────────────

  async autoLaunchIfEligible(userId: string, product: Product): Promise<void> {
    const d = product.decision as AdsDecision | 'REJECT' | 'PENDING';
    if (d !== 'RUN_ADS' && d !== 'TEST_ADS') {
      this.logger.debug(`Meta Ads skipped for product ${product.id} (decision: ${d})`);
      return;
    }
    try {
      await this.launchCampaign(userId, product, d as AdsDecision);
    } catch (err) {
      this.logger.error(
        `Meta Ads auto-launch failed for product ${product.id}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  // ── Full launch ───────────────────────────────────────────────────────────

  async launchCampaign(
    userId:   string,
    product:  Product,
    decision: AdsDecision,
  ): Promise<{
    campaignId:   string;
    adSetId:      string;
    creativeId:   string;
    assetId:      string | null;
    mediaAssetId: string | null;
  }> {
    const campaign = await this.createCampaign(product, userId, decision);
    const adSet    = await this.createAdSet(product, userId, campaign.id, decision);
    const { creative, adMediaAssetId } = await this.createAdCreative(
      product, userId, campaign.id, adSet.id,
    );

    await this.markActive(campaign.id, adSet.id, creative.id);

    if (campaign.adCopy && Object.keys(campaign.adCopy as object).length === 0) {
      await this.db
        .update(schema.campaigns)
        .set({
          adCopy:    { headline: creative.headline, body: creative.body },
          updatedAt: new Date(),
        })
        .where(eq(schema.campaigns.id, campaign.id));
    }

    this.logger.log(
      `Meta Ads launched – product=${product.id} ` +
      `campaign=${campaign.id} adset=${adSet.id} ` +
      `creative=${creative.id} mediaAsset=${adMediaAssetId ?? 'n/a'}`,
    );

    return {
      campaignId:   campaign.id,
      adSetId:      adSet.id,
      creativeId:   creative.id,
      assetId:      null,          // legacy field kept for API compatibility
      mediaAssetId: adMediaAssetId,
    };
  }

  // ── Step 1 – Campaign ─────────────────────────────────────────────────────

  async createCampaign(
    product:  Product,
    userId:   string,
    decision: AdsDecision,
  ): Promise<typeof schema.campaigns.$inferSelect> {
    const objective = OBJECTIVE[decision];
    const budget    = randomBudget(BUDGET[decision]);
    const name      = `[${decision}] ${product.title.slice(0, 80)} – Meta`;

    const [campaign] = await this.db
      .insert(schema.campaigns)
      .values({
        userId,
        productId:      product.id,
        platform:       'meta',
        name,
        objective,
        targetAudience: buildTargeting(product),
        budgetDaily:    String(budget),
        adCopy:         {},
        keywords:       product.tags ?? [],
        status:         'pending',
        aiGenerated:    false,
      })
      .returning();

    try {
      const res = await this.metaApi.createCampaign({
        name,
        objective,
        status:                'ACTIVE',
        special_ad_categories: [],
        daily_budget:          budget * 100,
      });

      await this.db
        .update(schema.campaigns)
        .set({ externalId: res.id, status: 'active', updatedAt: new Date() })
        .where(eq(schema.campaigns.id, campaign.id));

      return { ...campaign, externalId: res.id, status: 'active' };
    } catch (err) {
      this.logger.error(`Meta createCampaign failed: ${(err as Error).message}`);
      await this.db
        .update(schema.campaigns)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(schema.campaigns.id, campaign.id));
      return { ...campaign, status: 'error' };
    }
  }

  // ── Step 2 – Ad Set ───────────────────────────────────────────────────────

  async createAdSet(
    product:    Product,
    userId:     string,
    campaignId: string,
    decision:   AdsDecision,
  ): Promise<typeof schema.metaAdSets.$inferSelect> {
    const budget    = randomBudget(BUDGET[decision]);
    const targeting = buildTargeting(product);
    const goal      = GOAL[decision];
    const name      = `AdSet – ${product.title.slice(0, 60)}`;

    const [adSet] = await this.db
      .insert(schema.metaAdSets)
      .values({
        campaignId,
        userId,
        productId:        product.id,
        name,
        targeting,
        budgetDaily:      String(budget),
        billingEvent:     'IMPRESSIONS',
        optimizationGoal: goal,
        status:           'pending',
      })
      .returning();

    const campaignRow = await this.db.query.campaigns.findFirst({
      where: eq(schema.campaigns.id, campaignId),
    });
    const metaCampaignId = campaignRow?.externalId ?? campaignId;

    try {
      const res = await this.metaApi.createAdSet({
        name,
        campaign_id:       metaCampaignId,
        daily_budget:      budget * 100,
        billing_event:     'IMPRESSIONS',
        optimization_goal: goal,
        targeting,
        status:            'ACTIVE',
      });

      await this.db
        .update(schema.metaAdSets)
        .set({ externalId: res.id, status: 'active', updatedAt: new Date() })
        .where(eq(schema.metaAdSets.id, adSet.id));

      return { ...adSet, externalId: res.id, status: 'active' };
    } catch (err) {
      this.logger.error(`Meta createAdSet failed: ${(err as Error).message}`);
      await this.db
        .update(schema.metaAdSets)
        .set({ status: 'error', errorMessage: (err as Error).message, updatedAt: new Date() })
        .where(eq(schema.metaAdSets.id, adSet.id));
      return { ...adSet, status: 'error' };
    }
  }

  // ── Step 3 – Creative (cache-first AI media) ──────────────────────────────

  async createAdCreative(
    product:    Product,
    userId:     string,
    campaignId: string,
    adSetId:    string,
  ): Promise<{
    creative:       typeof schema.metaAdCreatives.$inferSelect;
    adMediaAssetId: string | null;
  }> {
    // AI text copy (unchanged)
    const { headline, body } = await this.creativeGenerator.getBestCreativePair(
      product, userId, campaignId,
    );

    // ── Cache-first AI image ─────────────────────────────────────────────────
    //
    // Priority:
    //   1. getBestCreative()   — most-reused cached asset (0 API calls)
    //   2. generateAdMedia()   — fresh generation with retry×2 + fallback
    //   3. product.imageUrls[0] — existing product image as last resort
    //
    let imageUrl:       string | null = product.imageUrls?.[0] ?? null;
    let adMediaAssetId: string | null = null;

    try {
      // 1. Try cached best creative first
      const best = await this.aiMedia.getBestCreative(product.id);

      if (best && best.success && best.imageUrl) {
        imageUrl       = best.imageUrl;
        adMediaAssetId = best.assetId;

        this.logger.log(
          `[META] Cache hit for product ${product.id}: ` +
          `assetId=${adMediaAssetId}`,
        );
      } else {
        // 2. Generate fresh (handles retry + fallback internally)
        const generated = await this.aiMedia.generateAdMedia(product, campaignId);

        if (generated.imageUrl) {
          imageUrl       = generated.imageUrl;
          adMediaAssetId = generated.assetId;

          this.logger.log(
            `[META] Generated media for product ${product.id}: ` +
            `cached=${generated.cached} success=${generated.success} ` +
            `ms=${generated.generationTimeMs}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `[META] AI image resolution failed, using product image: ` +
        `${(err as Error).message}`,
      );
    }

    const linkUrl = `https://yourstore.com/products/${product.id}`;
    const name    = `Creative – ${product.title.slice(0, 50)}`;

    const [creative] = await this.db
      .insert(schema.metaAdCreatives)
      .values({
        adSetId,
        campaignId,
        userId,
        productId: product.id,
        name,
        headline:  headline.slice(0, 255),
        body:      body.slice(0, 600),
        cta:       'SHOP_NOW',
        imageUrl,
        linkUrl,
        status:    'pending',
      })
      .returning();

    try {
      const res = await this.metaApi.createAdCreative({
        name,
        object_story_spec: {
          page_id: this.metaApi.effectivePageId,
          link_data: {
            message:        body.slice(0, 600),
            name:           headline.slice(0, 255),
            call_to_action: { type: 'SHOP_NOW' },
            ...(imageUrl ? { image_url: imageUrl } : {}),
            link:           linkUrl,
          },
        },
      });

      await this.db
        .update(schema.metaAdCreatives)
        .set({ externalId: res.id, status: 'active', updatedAt: new Date() })
        .where(eq(schema.metaAdCreatives.id, creative.id));

      return {
        creative: { ...creative, externalId: res.id, status: 'active' },
        adMediaAssetId,
      };
    } catch (err) {
      this.logger.error(`Meta createAdCreative failed: ${(err as Error).message}`);
      await this.db
        .update(schema.metaAdCreatives)
        .set({
          status:       'error',
          errorMessage: (err as Error).message,
          updatedAt:    new Date(),
        })
        .where(eq(schema.metaAdCreatives.id, creative.id));

      return { creative: { ...creative, status: 'error' }, adMediaAssetId };
    }
  }

  // ── Step 4 – Mark all active ──────────────────────────────────────────────

  private async markActive(
    campaignId: string,
    adSetId:    string,
    creativeId: string,
  ): Promise<void> {
    await Promise.allSettled([
      this.db.update(schema.campaigns)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(schema.campaigns.id, campaignId)),
      this.db.update(schema.metaAdSets)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(schema.metaAdSets.id, adSetId)),
      this.db.update(schema.metaAdCreatives)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(schema.metaAdCreatives.id, creativeId)),
    ]);
  }

  // ── FIX #2: duplicateAdSet — real Meta API adset duplication ─────────────
  //
  // Called by AutonomousLoopService when DUPLICATE_ADSET action executes.
  // Clones the most-recent active adset for the campaign with a new budget,
  // writes DB record, fires Meta API createAdSet.
  //
  // Safe: mock mode (no META_ACCESS_TOKEN) returns immediately without API call.
  // On Meta failure: DB record is marked 'error', exception propagates to caller.

  async duplicateAdSet(campaignId: string, dailyBudgetUsd: number): Promise<string> {
    const sourceAdSet = await this.db.query.metaAdSets.findFirst({
      where: (a, { and, eq: eqFn }) =>
        and(eqFn(a.campaignId, campaignId), eqFn(a.status, 'active')),
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });

    if (!sourceAdSet) {
      this.logger.warn(`[MetaAdsService] duplicateAdSet: no active adset for campaign ${campaignId}`);
      return `mock_no_source_${campaignId}`;
    }

    const campaignRow = await this.db.query.campaigns.findFirst({
      where: eq(schema.campaigns.id, campaignId),
    });
    const metaCampaignId = campaignRow?.externalId ?? campaignId;

    const name = `AdSet-DUP – ${sourceAdSet.name.slice(0, 50)} – $${dailyBudgetUsd}/day`;

    const [newAdSet] = await this.db
      .insert(schema.metaAdSets)
      .values({
        campaignId,
        userId:           sourceAdSet.userId,
        productId:        sourceAdSet.productId,
        name,
        targeting:        sourceAdSet.targeting as Record<string, unknown>,
        budgetDaily:      String(dailyBudgetUsd),
        billingEvent:     sourceAdSet.billingEvent ?? 'IMPRESSIONS',
        optimizationGoal: sourceAdSet.optimizationGoal ?? 'OFFSITE_CONVERSIONS',
        status:           'pending',
      })
      .returning();

    try {
      const res = await this.metaApi.createAdSet({
        name,
        campaign_id:       metaCampaignId,
        daily_budget:      Math.round(dailyBudgetUsd * 100),
        billing_event:     sourceAdSet.billingEvent ?? 'IMPRESSIONS',
        optimization_goal: sourceAdSet.optimizationGoal ?? 'OFFSITE_CONVERSIONS',
        targeting:         sourceAdSet.targeting as Record<string, unknown>,
        status:            'ACTIVE',
      });

      await this.db
        .update(schema.metaAdSets)
        .set({ externalId: res.id, status: 'active', updatedAt: new Date() })
        .where(eq(schema.metaAdSets.id, newAdSet.id));

      this.logger.log(
        `[MetaAdsService] ✅ Duplicated adset → ${res.id} | campaign=${campaignId} budget=$${dailyBudgetUsd}/day`,
      );
      return res.id;
    } catch (err) {
      this.logger.error(`[MetaAdsService] duplicateAdSet failed: ${(err as Error).message}`);
      await this.db
        .update(schema.metaAdSets)
        .set({ status: 'error', errorMessage: (err as Error).message, updatedAt: new Date() })
        .where(eq(schema.metaAdSets.id, newAdSet.id));
      throw err;
    }
  }

  // ── Read helpers ──────────────────────────────────────────────────────────

  async findCampaignsByProduct(userId: string, productId: string) {
    return this.db.query.campaigns.findMany({
      where: (c, { and, eq: eqFn }) =>
        and(eqFn(c.userId, userId), eqFn(c.productId, productId), eqFn(c.platform, 'meta')),
      with: { metaAdSets: { with: { creatives: true } } },
    });
  }

  async findAdSetsByCampaign(userId: string, campaignId: string) {
    return this.db.query.metaAdSets.findMany({
      where: (a, { and, eq: eqFn }) =>
        and(eqFn(a.userId, userId), eqFn(a.campaignId, campaignId)),
      with: { creatives: true },
    });
  }
}
