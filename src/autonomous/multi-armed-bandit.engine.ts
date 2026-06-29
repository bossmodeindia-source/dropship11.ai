/**
 * MultiArmedBanditEngine — V17 READ-ONLY ALLOCATION
 *
 * V17 FIX (P1 CRITICAL): computeAndApplyAllocation() previously called
 * MetaApiClient.updateAdsetBudget() DIRECTLY — bypassing all 23 kernel gates,
 * idempotency, 2PC, capital limits, and safe mode checks.
 *
 * FIX:
 *   computeAndApplyAllocation() is REMOVED.
 *   All budget reallocations must go through OptimizationScheduler → RCCSKernel.
 *
 *   Bandit now provides: computeAllocation() — pure math, no Meta API calls.
 *   OptimizationScheduler reads bandit recommendations and executes them via kernel.
 *
 * WHAT BANDIT STILL DOES:
 *   - Reads creative performance from DB
 *   - Computes Thompson sampling allocation
 *   - Returns BanditAllocation[] (recommended splits)
 *   - Persists recommendations to DB (read-only from capital perspective)
 *
 * WHAT BANDIT NO LONGER DOES:
 *   - Calls Meta API directly (REMOVED)
 *   - Makes autonomous budget mutations (REMOVED)
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export interface BanditCreative {
  creativeId:  string;
  adsetId:     string | null;
  wins:        number;
  losses:      number;
  impressions: number;
  clicks:      number;
  conversions: number;
}

export interface BanditAllocation {
  creativeId:        string;
  adsetId:           string | null;
  allocationPct:     number;  // 0-100
  recommendedBudget: number;  // INR
  isWinner:          boolean;
  thompsonScore:     number;
  // V17: no apiUpdated / apiCallsMade — bandit no longer calls Meta
}

export interface BanditResult {
  campaignId:   string;
  totalBudget:  number;
  allocations:  BanditAllocation[];
  // V17: apiCallsMade always 0 — budget writes go through kernel
  apiCallsMade: 0;
}

const MIN_IMPRESSIONS_FOR_THOMPSON = 100;

@Injectable()
export class MultiArmedBanditEngine {
  private readonly logger = new Logger(MultiArmedBanditEngine.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Compute budget allocation recommendations using Thompson Sampling.
   * READ-ONLY — no Meta API calls.
   * Returns recommendations for OptimizationScheduler to execute via kernel.
   */
  async computeAllocation(
    campaignId:  string,
    totalBudget: number,
  ): Promise<BanditResult> {
    const creatives = await this.fetchCreativeStats(campaignId);

    if (!creatives.length) {
      return { campaignId, totalBudget, allocations: [], apiCallsMade: 0 };
    }

    const allocations = this.computeThompsonAllocations(creatives, totalBudget);

    // Persist recommendations to DB (no Meta API call)
    await this.persistRecommendations(campaignId, allocations).catch(err =>
      this.logger.warn(`Bandit persist failed: ${err.message}`),
    );

    this.logger.debug(
      `[Bandit] campaign=${campaignId} creatives=${creatives.length} ` +
      `budget=₹${totalBudget} allocations computed (NO Meta API call)`,
    );

    return { campaignId, totalBudget, allocations, apiCallsMade: 0 };
  }

  /**
   * Get latest cached allocation recommendations for a campaign.
   * Used by OptimizationScheduler to read bandit state before kernel execution.
   */
  async getLatestAllocations(campaignId: string): Promise<BanditAllocation[]> {
    try {
      const rows = await this.db.execute(sql`
        SELECT creative_id, adset_id, allocation_pct, recommended_budget_inr, is_winner, thompson_score
        FROM bandit_recommendations
        WHERE campaign_id = ${campaignId}
          AND created_at > NOW() - INTERVAL '2 hours'
        ORDER BY allocation_pct DESC
      `) as unknown as Array<{
        creative_id: string;
        adset_id: string | null;
        allocation_pct: number;
        recommended_budget_inr: number;
        is_winner: boolean;
        thompson_score: number;
      }>;

      return rows.map(r => ({
        creativeId:        r.creative_id,
        adsetId:           r.adset_id,
        allocationPct:     r.allocation_pct,
        recommendedBudget: r.recommended_budget_inr,
        isWinner:          r.is_winner,
        thompsonScore:     r.thompson_score,
      }));
    } catch {
      return [];
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private computeThompsonAllocations(
    creatives:   BanditCreative[],
    totalBudget: number,
  ): BanditAllocation[] {
    const samples = creatives.map(c => {
      const alpha = c.wins + 1;
      const beta  = c.losses + 1;
      // Thompson sampling: sample from Beta(alpha, beta)
      const sample = this.betaSample(alpha, beta);
      return { creative: c, sample };
    });

    // Sort by Thompson sample score
    samples.sort((a, b) => b.sample - a.sample);

    // Assign budget: winner 60-70%, mid 20-30%, rest share remainder
    const total = samples.length;
    const allocations: BanditAllocation[] = [];
    let remaining = 100;

    samples.forEach((s, i) => {
      let pct: number;
      if (total === 1) {
        pct = 100;
      } else if (i === 0) {
        pct = total <= 2 ? 70 : 60;
      } else if (i === 1) {
        pct = total <= 2 ? 30 : 25;
      } else {
        // Distribute remainder equally among losers, minimum 5%
        pct = Math.max(5, Math.floor(remaining / (total - i)));
      }

      pct = Math.min(pct, remaining);
      remaining -= pct;

      allocations.push({
        creativeId:        s.creative.creativeId,
        adsetId:           s.creative.adsetId,
        allocationPct:     pct,
        recommendedBudget: Math.round(totalBudget * pct / 100),
        isWinner:          i === 0,
        thompsonScore:     Math.round(s.sample * 10000) / 10000,
      });
    });

    // Give any leftover to winner
    if (remaining > 0 && allocations.length > 0) {
      allocations[0].allocationPct   += remaining;
      allocations[0].recommendedBudget = Math.round(totalBudget * allocations[0].allocationPct / 100);
    }

    return allocations;
  }

  private async fetchCreativeStats(campaignId: string): Promise<BanditCreative[]> {
    try {
      const rows = await this.db.execute(sql`
        SELECT mac.id AS creative_id, mas.id AS adset_id,
               COALESCE(mac.wins, 0) AS wins, COALESCE(mac.losses, 0) AS losses,
               COALESCE(mac.impressions, 0) AS impressions,
               COALESCE(mac.clicks, 0) AS clicks,
               COALESCE(mac.conversions, 0) AS conversions
        FROM meta_ad_creatives mac
        JOIN meta_ad_sets mas ON mas.id = mac.ad_set_id
        WHERE mac.campaign_id = ${campaignId}
          AND mac.status = 'active'
        ORDER BY mac.impressions DESC
        LIMIT 10
      `) as unknown as BanditCreative[];
      return rows;
    } catch {
      return [];
    }
  }

  private async persistRecommendations(
    campaignId:  string,
    allocations: BanditAllocation[],
  ): Promise<void> {
    if (!allocations.length) return;

    // Delete old recommendations for this campaign
    await this.db.execute(sql`
      DELETE FROM bandit_recommendations WHERE campaign_id = ${campaignId}
    `).catch(() => null);

    for (const a of allocations) {
      await this.db.execute(sql`
        INSERT INTO bandit_recommendations (
          campaign_id, creative_id, adset_id, allocation_pct,
          recommended_budget_inr, is_winner, thompson_score, created_at
        ) VALUES (
          ${campaignId}, ${a.creativeId}, ${a.adsetId ?? null},
          ${a.allocationPct}, ${a.recommendedBudget}, ${a.isWinner},
          ${a.thompsonScore}, NOW()
        )
        ON CONFLICT (campaign_id, creative_id) DO UPDATE SET
          allocation_pct         = EXCLUDED.allocation_pct,
          recommended_budget_inr = EXCLUDED.recommended_budget_inr,
          is_winner              = EXCLUDED.is_winner,
          thompson_score         = EXCLUDED.thompson_score,
          created_at             = NOW()
      `).catch(() => null);
    }
  }

  /**
   * Simple Beta distribution sampler using Johnk's method.
   */
  private betaSample(alpha: number, beta: number): number {
    // For small alpha/beta use Johnk's method
    let x: number, y: number;
    do {
      x = Math.pow(Math.random(), 1 / alpha);
      y = Math.pow(Math.random(), 1 / beta);
    } while (x + y > 1);
    return x / (x + y);
  }
}
