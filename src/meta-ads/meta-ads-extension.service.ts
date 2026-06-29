/**
 * MetaAdsServiceExtension
 *
 * Adds scaleCampaign() and pauseCampaign() methods required by CampaignModeService.
 * In production, extend MetaAdsService directly. Here we use a mixin pattern
 * to avoid modifying the existing service file (which would require rebuilding V1–V45 tests).
 *
 * These methods are also available as standalone injectable service
 * exported from MetaAdsModule.
 */

import { Injectable, Logger, Inject, NotFoundException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { MetaApiClient } from './meta-api.client';

/** Local shape for Drizzle campaign query result with eager-loaded adSets */
interface CampaignWithAdSets {
  id:         string;
  userId:     string;
  metaAdSets: Array<{
    id:          string;
    externalId:  string | null;
    status:      string;
    dailyBudget: string | null;
  }>;
}

@Injectable()
export class MetaAdsExtensionService {
  private readonly logger = new Logger(MetaAdsExtensionService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly metaApi: MetaApiClient,
  ) {}

  /**
   * Scale a campaign by adjusting all active ad sets' daily budget.
   * factor > 1 = scale up, factor < 1 = scale down.
   */
  async scaleCampaign(userId: string, campaignId: string, factor: number): Promise<void> {
    const campaign = await this.db.query.campaigns.findFirst({
      where: (c, { and, eq: eqFn }) =>
        and(eqFn(c.id, campaignId), eqFn(c.userId, userId)),
      with: { metaAdSets: true },
    });

    if (!campaign) throw new NotFoundException('Campaign not found');
    const typedCampaign = campaign as unknown as CampaignWithAdSets;

    for (const adSet of typedCampaign.metaAdSets ?? []) {
      if (!adSet.externalId || adSet.status !== 'active') continue;

      const currentBudget = parseFloat(adSet.dailyBudget ?? '1000');
      const newBudget     = Math.round(currentBudget * factor * 100); // in cents

      try {
        await this.metaApi.updateAdSet(adSet.externalId, { daily_budget: newBudget });
        await this.db
          .update(schema.metaAdSets)
          .set({ budgetDaily: String(currentBudget * factor), updatedAt: new Date() })
          .where(eq(schema.metaAdSets.id, adSet.id));

        this.logger.log(
          `[Scale] AdSet ${adSet.externalId}: budget ₹${currentBudget} → ₹${currentBudget * factor}`,
        );
      } catch (err: any) {
        this.logger.error(`[Scale] AdSet ${adSet.externalId} failed: ${err.message}`);
      }
    }
  }

  /**
   * Pause all active ad sets in a campaign.
   */
  async pauseCampaign(userId: string, campaignId: string): Promise<void> {
    const campaign = await this.db.query.campaigns.findFirst({
      where: (c, { and, eq: eqFn }) =>
        and(eqFn(c.id, campaignId), eqFn(c.userId, userId)),
      with: { metaAdSets: true },
    });

    if (!campaign) throw new NotFoundException('Campaign not found');
    const typedCampaign = campaign as unknown as CampaignWithAdSets;

    for (const adSet of typedCampaign.metaAdSets ?? []) {
      if (!adSet.externalId || adSet.status === 'paused') continue;

      try {
        await this.metaApi.updateAdSet(adSet.externalId, { status: 'PAUSED' });
        await this.db
          .update(schema.metaAdSets)
          .set({ status: 'paused', updatedAt: new Date() })
          .where(eq(schema.metaAdSets.id, adSet.id));

        this.logger.log(`[Pause] AdSet ${adSet.externalId} paused`);
      } catch (err: any) {
        this.logger.error(`[Pause] AdSet ${adSet.externalId} failed: ${err.message}`);
      }
    }

    // Pause campaign record
    await this.db
      .update(schema.campaigns)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(
        and(
          eq(schema.campaigns.id,     campaignId),
          eq(schema.campaigns.userId, userId),
        ),
      );
  }
}
