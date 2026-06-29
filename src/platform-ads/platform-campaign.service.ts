/**
 * PlatformCampaignService — V60 PATCHED
 *
 * Fixes applied:
 *   [H1] applyScalingDecision: SCALE action now calls metaApi.updateAdsetBudget()
 *        in addition to writing to DB. Budget is converted INR→USD cents.
 *
 *   [H4] enforceSpendCap: hard cap is now read from EMPIRE_MAX_DAILY_SPEND env var
 *        (falls back to 100_000 so existing deploys are unaffected). No redeploy
 *        required to change the cap.
 *
 *   [BUDGET-BUG] launchCampaign: daily_budget sent to Meta is now converted
 *        INR → USD cents via MetaApiClient.inrToMetaCents().
 *        Before: INR*100 sent as USD cents → ₹500 campaign sent $50,000 to Meta.
 *        After:  INR * rate * 100 → ₹500 * 0.012 * 100 = 600 USD cents = $6/day.
 */

import {
  Injectable, Logger, Inject, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc } from 'drizzle-orm';
import { Pool } from 'pg';
import { DB_TOKEN, DB_POOL } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import {
  platformCampaigns,
  platformAdSets,
  platformMetrics,
} from './platform-ads.schema';
import { MetaApiClient, MetaCampaignPayload, MetaAdSetPayload } from '../meta-ads/meta-api.client';
import { MetaApiExecutionGuard } from '../common/guards/meta-api-execution.guard';
import { AlertingService } from '../alerting/alerting.service';
import { PlatformCreativeService, PlatformCreativeStyle } from './platform-creative.service';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface CreatePlatformCampaignDto {
  name: string;
  type: typeof platformCampaigns.$inferInsert['type'];
  mode: typeof platformCampaigns.$inferInsert['mode'];
  channel: typeof platformCampaigns.$inferInsert['channel'];
  dailyBudgetInr: number;
  maxDailySpendInr: number;
  creativeStyle: PlatformCreativeStyle;
  targeting?: Record<string, unknown>;
  geoLocations?: string[];
  ageMin?: number;
  ageMax?: number;
  destinationUrl?: string;
  notes?: string;
}

export interface ScalingDecision {
  action: 'SCALE' | 'PAUSE' | 'ROTATE_CREATIVES' | 'MAINTAIN';
  reason: string;
  newBudget?: number;
}

// ── Scaling thresholds ────────────────────────────────────────────────────────

const SCALING = {
  CAC_TARGET_INR:                    2000,
  MIN_ROAS:                          1.5,
  MIN_CTR:                           0.01,
  SIGNUP_CONVERSION_THRESHOLD:       0.02,
  SUBSCRIPTION_CONVERSION_THRESHOLD: 0.05,
  SCALE_MULTIPLIER:                  1.3,
  MAX_BUDGET_INR:                    50_000,
} as const;

@Injectable()
export class PlatformCampaignService {
  private readonly logger = new Logger(PlatformCampaignService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly metaApi: MetaApiClient,
    private readonly alerting: AlertingService,
    private readonly platformCreatives: PlatformCreativeService,
    private readonly config: ConfigService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async createCampaign(dto: CreatePlatformCampaignDto): Promise<typeof platformCampaigns.$inferSelect> {
    this.logger.log(`Creating platform campaign: ${dto.name}`);

    const [campaign] = await this.db
      .insert(platformCampaigns)
      .values({
        name:             dto.name,
        type:             dto.type,
        mode:             dto.mode,
        channel:          dto.channel,
        status:           'DRAFT',
        dailyBudgetInr:   dto.dailyBudgetInr,
        maxDailySpendInr: dto.maxDailySpendInr,
        targeting:        dto.targeting ?? {},
        geoLocations:     dto.geoLocations ?? ['IN'],
        ageMin:           dto.ageMin ?? 18,
        ageMax:           dto.ageMax ?? 45,
        destinationUrl:   dto.destinationUrl,
        notes:            dto.notes,
      })
      .returning();

    const bundle = await this.platformCreatives.generateBundle(dto.creativeStyle, campaign.id);
    await this.platformCreatives.scoreAndPersist(bundle, dto.creativeStyle, campaign.id);

    this.logger.log(`Platform campaign created: ${campaign.id}`);
    return campaign;
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async launchCampaign(campaignId: string): Promise<{ metaCampaignId: string }> {
    const campaign = await this.findOrThrow(campaignId);

    if (campaign.status === 'ACTIVE') {
      throw new BadRequestException('Campaign is already active');
    }

    this.logger.log(`Launching platform campaign: ${campaignId}`);

    const creative = await this.platformCreatives.pickWinnerThompson(campaignId);

    const metaPayload: MetaCampaignPayload = {
      name:                   `[PLATFORM] ${campaign.name}`,
      objective:              this.toMetaObjective(campaign.type),
      status:                 'ACTIVE',
      special_ad_categories:  [],
    };

    let metaCampaignId: string = '';
    let metaAdSetId: string = '';

    try {
      await MetaApiExecutionGuard.runInEmergencyContext(`platform-launch-${campaignId}`, async () => {
        const metaResult = await this.metaApi.createCampaign(metaPayload);
        metaCampaignId = metaResult.id;

        // [BUDGET-BUG FIXED] Convert INR → USD cents for Meta's daily_budget field.
        // Old code: dailyBudgetInr * 100 (sent INR paise as if they were USD cents)
        // New code: inrToMetaCents() → INR * rate * 100 = correct USD cents
        const dailyBudgetUsdCents = this.metaApi.inrToMetaCents(campaign.dailyBudgetInr);

        const adSetPayload: MetaAdSetPayload = {
          name:              `[PLATFORM] ${campaign.name} — Ad Set 1`,
          campaign_id:       metaCampaignId,
          daily_budget:      dailyBudgetUsdCents,
          billing_event:     'IMPRESSIONS',
          optimization_goal: this.toMetaOptGoal(campaign.type),
          targeting:         this.buildMetaTargeting(campaign),
          status:            'ACTIVE',
        };

        const adSet = await this.metaApi.createAdSet(adSetPayload);
        metaAdSetId = adSet.id;

        await this.db.insert(platformAdSets).values({
          campaignId:       campaignId,
          name:             adSetPayload.name,
          metaAdSetId:      adSet.id,
          status:           'ACTIVE',
          dailyBudget:      campaign.dailyBudgetInr,
          targeting:        this.buildMetaTargeting(campaign),
          optimizationGoal: adSetPayload.optimization_goal,
        });
      });
    } catch (err) {
      this.logger.error(`Meta campaign launch failed: ${(err as Error).message}`);
      await this.alerting.sendCritical({
        title:   'Platform Campaign Launch Failed',
        message: `Campaign ${campaign.name} failed to launch on Meta: ${(err as Error).message}`,
      });
      throw err;
    }

    await this.db
      .update(platformCampaigns)
      .set({
        status:         'ACTIVE',
        metaCampaignId: metaCampaignId,
        updatedAt:      new Date(),
      })
      .where(eq(platformCampaigns.id, campaignId));

    this.logger.log(`Platform campaign launched: ${campaignId} → Meta ${metaCampaignId}`);
    return { metaCampaignId };
  }

  // ── Pause / Resume ────────────────────────────────────────────────────────

  async pauseCampaign(campaignId: string): Promise<void> {
    const campaign = await this.findOrThrow(campaignId);
    if (campaign.metaCampaignId) {
      const idempotencyKey = `platform-pause-${campaignId}-${Date.now()}`;
      await MetaApiExecutionGuard.runInEmergencyContext(
        `platform-pause-${campaignId}`,
        () => this.metaApi.pauseCampaign(campaign.metaCampaignId!, idempotencyKey),
      );
    }
    await this.db
      .update(platformCampaigns)
      .set({ status: 'PAUSED', updatedAt: new Date() })
      .where(eq(platformCampaigns.id, campaignId));
    this.logger.log(`Platform campaign paused: ${campaignId}`);
  }

  async resumeCampaign(campaignId: string): Promise<void> {
    const campaign = await this.findOrThrow(campaignId);
    if (campaign.metaCampaignId) {
      await MetaApiExecutionGuard.runInEmergencyContext(
        `platform-resume-${campaignId}`,
        () => this.metaApi.resumeCampaign(campaign.metaCampaignId!),
      );
    }
    await this.db
      .update(platformCampaigns)
      .set({ status: 'ACTIVE', updatedAt: new Date() })
      .where(eq(platformCampaigns.id, campaignId));
    this.logger.log(`Platform campaign resumed: ${campaignId}`);
  }

  // ── AI Scaling Logic ──────────────────────────────────────────────────────

  async evaluateScaling(campaignId: string): Promise<ScalingDecision> {
    const campaign = await this.findOrThrow(campaignId);

    const [metrics] = await this.db
      .select()
      .from(platformMetrics)
      .where(eq(platformMetrics.campaignId, campaignId))
      .orderBy(desc(platformMetrics.date))
      .limit(1);

    if (!metrics) {
      return { action: 'MAINTAIN', reason: 'No metrics yet — waiting for data' };
    }

    const cac       = Number(metrics.cac ?? 0);
    const roas      = Number(metrics.roas ?? 0);
    const ctr       = Number(metrics.ctr ?? 0);
    const signupCvr = Number(metrics.signupConversionRate ?? 0);
    const subCvr    = Number(metrics.subscriptionConversionRate ?? 0);

    if (roas > 0 && roas < SCALING.MIN_ROAS) {
      return {
        action: 'PAUSE',
        reason: `ROAS ${roas.toFixed(2)} below minimum ${SCALING.MIN_ROAS}`,
      };
    }

    if (cac > 0 && cac > SCALING.CAC_TARGET_INR) {
      return {
        action: 'PAUSE',
        reason: `CAC ₹${cac.toFixed(0)} exceeds target ₹${SCALING.CAC_TARGET_INR}`,
      };
    }

    if (ctr > 0 && ctr < SCALING.MIN_CTR) {
      return {
        action: 'ROTATE_CREATIVES',
        reason: `CTR ${(ctr * 100).toFixed(2)}% below threshold ${(SCALING.MIN_CTR * 100).toFixed(2)}%`,
      };
    }

    if (
      cac > 0 && cac < SCALING.CAC_TARGET_INR &&
      signupCvr > SCALING.SIGNUP_CONVERSION_THRESHOLD &&
      subCvr > SCALING.SUBSCRIPTION_CONVERSION_THRESHOLD
    ) {
      const currentBudget = campaign.dailyBudgetInr;
      const newBudget = Math.min(
        Math.round(currentBudget * SCALING.SCALE_MULTIPLIER),
        SCALING.MAX_BUDGET_INR,
      );
      return {
        action:    'SCALE',
        reason:    `CAC ₹${cac.toFixed(0)} < target, CVR metrics healthy — scaling budget ${currentBudget} → ${newBudget}`,
        newBudget,
      };
    }

    return { action: 'MAINTAIN', reason: 'Metrics within acceptable range — holding budget' };
  }

  /**
   * [H1] FIXED: applyScalingDecision now propagates budget changes to Meta.
   *
   * BEFORE: wrote dailyBudgetInr to DB only — Meta adset stayed at original budget forever.
   * AFTER:  writes to DB, then fetches active adset, then calls metaApi.updateAdsetBudget()
   *         so the live Meta campaign actually reflects the new budget.
   */
  async applyScalingDecision(campaignId: string, decision: ScalingDecision): Promise<void> {
    if (decision.action === 'PAUSE') {
      await this.pauseCampaign(campaignId);
      await this.alerting.sendWarn({
        title:   'Platform Campaign Auto-Paused',
        message: `Campaign ${campaignId} paused by AI: ${decision.reason}`,
      });
      return;
    }

    if (decision.action === 'SCALE' && decision.newBudget) {
      // 1. Update DB
      await this.db
        .update(platformCampaigns)
        .set({ dailyBudgetInr: decision.newBudget, updatedAt: new Date() })
        .where(eq(platformCampaigns.id, campaignId));

      // 2. Sync DB adsets record
      await this.db
        .update(platformAdSets)
        .set({ dailyBudget: decision.newBudget, updatedAt: new Date() })
        .where(eq(platformAdSets.campaignId, campaignId));

      // 3. [H1 FIX] Propagate to Meta — fetch active adset and call updateAdsetBudget
      const [activeAdSet] = await this.db
        .select()
        .from(platformAdSets)
        .where(eq(platformAdSets.campaignId, campaignId))
        .limit(1);

      if (activeAdSet?.metaAdSetId) {
        const newBudgetUsdCents = this.metaApi.inrToMetaCents(decision.newBudget);
        try {
          await MetaApiExecutionGuard.runInEmergencyContext(
            `platform-scale-${campaignId}`,
            () => this.metaApi.updateAdsetBudget(activeAdSet.metaAdSetId!, newBudgetUsdCents),
          );
          this.logger.log(
            `[H1] Meta adset budget updated: campaign=${campaignId} ` +
            `adset=${activeAdSet.metaAdSetId} newBudget=₹${decision.newBudget} ` +
            `(${newBudgetUsdCents} USD cents)`,
          );
        } catch (err) {
          // Log and alert but don't throw — DB is the source of truth,
          // the scheduler will retry on next cycle.
          this.logger.error(
            `Meta budget sync failed for adset=${activeAdSet.metaAdSetId}: ${(err as Error).message}`,
          );
          await this.alerting.sendWarn({
            title:   'Platform Meta Budget Sync Failed',
            message: `Campaign ${campaignId}: DB updated to ₹${decision.newBudget} but Meta sync failed. Will retry next cycle.`,
          });
        }
      } else {
        this.logger.warn(
          `No active adset with meta_ad_set_id found for campaign ${campaignId} — skipping Meta sync`,
        );
      }

      this.logger.log(`Budget scaled to ₹${decision.newBudget} for campaign ${campaignId}`);
    }

    if (decision.action === 'ROTATE_CREATIVES') {
      const [campaign] = await this.db
        .select()
        .from(platformCampaigns)
        .where(eq(platformCampaigns.id, campaignId));
      if (campaign) {
        const bundle = await this.platformCreatives.generateBundle('AI_AUTOMATION', campaignId);
        await this.platformCreatives.scoreAndPersist(bundle, 'AI_AUTOMATION', campaignId);
        this.logger.log(`Rotated creatives for campaign ${campaignId}`);
      }
    }
  }

  // ── Cost Protection ───────────────────────────────────────────────────────

  /**
   * [H4] FIXED: Hard cap now reads from EMPIRE_MAX_DAILY_SPEND env var.
   *
   * BEFORE: hardcoded literal `100_000` — changing the cap required a redeploy.
   * AFTER:  reads from process env; falls back to 100_000 for backwards compat.
   *
   * Set EMPIRE_MAX_DAILY_SPEND=50000 in .env to halve the cap without deploying.
   */
  async enforceSpendCap(): Promise<void> {
    const result = await this.pool.query<{ total: string }>(`
      SELECT COALESCE(SUM(spend_inr::numeric), 0)::text AS total
      FROM platform_metrics
      WHERE date >= CURRENT_DATE
    `);

    const todaySpend = Number(result.rows[0]?.total ?? 0);

    // [H4 FIX] Read from env, not hardcoded literal
    const hardCap = parseInt(
      this.config.get<string>('EMPIRE_MAX_DAILY_SPEND', '100000'),
      10,
    );

    if (todaySpend >= hardCap) {
      this.logger.warn(
        `Platform daily spend ₹${todaySpend} hit hard cap ₹${hardCap} — pausing all campaigns`,
      );
      await this.pauseAllCampaigns('Daily spend cap reached');
      await this.alerting.sendCritical({
        title:   '🚨 Platform Spend Cap Hit',
        message: `Daily platform ad spend ₹${todaySpend.toFixed(0)} exceeded hard cap ₹${hardCap}. All campaigns paused.`,
      });
    }
  }

  async pauseAllCampaigns(reason: string): Promise<void> {
    const active = await this.db
      .select()
      .from(platformCampaigns)
      .where(eq(platformCampaigns.status, 'ACTIVE'));

    for (const campaign of active) {
      try {
        if (campaign.metaCampaignId) {
          const idempotencyKey = `platform-killall-${campaign.id}-${Date.now()}`;
          await MetaApiExecutionGuard.runInEmergencyContext(
            `platform-killall-${campaign.id}`,
            () => this.metaApi.pauseCampaign(campaign.metaCampaignId!, idempotencyKey),
          );
        }
      } catch (err) {
        this.logger.error(
          `Failed to pause Meta campaign ${campaign.metaCampaignId}: ${(err as Error).message}`,
        );
      }
    }

    await this.db
      .update(platformCampaigns)
      .set({ status: 'PAUSED', updatedAt: new Date() })
      .where(eq(platformCampaigns.status, 'ACTIVE'));

    this.logger.log(`All platform campaigns paused: ${reason}`);
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listCampaigns(): Promise<typeof platformCampaigns.$inferSelect[]> {
    return this.db.select().from(platformCampaigns).orderBy(desc(platformCampaigns.createdAt));
  }

  async getCampaign(id: string): Promise<typeof platformCampaigns.$inferSelect> {
    return this.findOrThrow(id);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async findOrThrow(id: string): Promise<typeof platformCampaigns.$inferSelect> {
    const [row] = await this.db.select().from(platformCampaigns).where(eq(platformCampaigns.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Platform campaign not found: ${id}`);
    return row;
  }

  private toMetaObjective(type: typeof platformCampaigns.$inferInsert['type']): MetaCampaignPayload['objective'] {
    const map: Record<string, MetaCampaignPayload['objective']> = {
      WEBSITE_TRAFFIC:          'TRAFFIC',
      SIGNUP:                   'CONVERSIONS',
      FREE_TRIAL:               'CONVERSIONS',
      SUBSCRIPTION_CONVERSION:  'CONVERSIONS',
      RETARGETING:              'CONVERSIONS',
      WHATSAPP_LEAD:            'ENGAGEMENT',
      VIDEO_VIEW:               'AWARENESS',
    };
    return map[type as string] ?? 'CONVERSIONS';
  }

  private toMetaOptGoal(type: typeof platformCampaigns.$inferInsert['type']): string {
    const map: Record<string, string> = {
      WEBSITE_TRAFFIC:          'LINK_CLICKS',
      SIGNUP:                   'OFFSITE_CONVERSIONS',
      FREE_TRIAL:               'OFFSITE_CONVERSIONS',
      SUBSCRIPTION_CONVERSION:  'OFFSITE_CONVERSIONS',
      RETARGETING:              'OFFSITE_CONVERSIONS',
      WHATSAPP_LEAD:            'LEAD_GENERATION',
      VIDEO_VIEW:               'VIDEO_VIEWS',
    };
    return map[type as string] ?? 'LINK_CLICKS';
  }

  private buildMetaTargeting(campaign: typeof platformCampaigns.$inferSelect): Record<string, unknown> {
    return {
      geo_locations:       { countries: campaign.geoLocations ?? ['IN'] },
      age_min:             campaign.ageMin ?? 18,
      age_max:             campaign.ageMax ?? 45,
      genders:             [0],
      flexible_spec: [
        {
          interests: [
            { id: '6003232518610', name: 'Online shopping' },
            { id: '6003379789830', name: 'Entrepreneurship' },
            { id: '6003386397459', name: 'E-commerce' },
            { id: '6003229566785', name: 'Shopify' },
            { id: '6003397513780', name: 'Artificial intelligence' },
          ],
        },
      ],
      publisher_platforms: ['facebook', 'instagram'],
      device_platforms:    ['mobile', 'desktop'],
      ...campaign.targeting,
    };
  }
}
