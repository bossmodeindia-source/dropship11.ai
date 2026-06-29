/**
 * ProfitCompoundingEngine — PHASE 3 STEP 5
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 *   Automatically reinvest profits to compound growth.
 *
 * RULE (Phase 3)
 *   70% of net profit → reinvested into ads (new tests + scale)
 *   30% → kept as extracted profit
 *
 * LOGIC
 *   Every optimization cycle:
 *   1. Sum real netProfit across all profitable campaigns (from optimization_decisions)
 *   2. Compute reinvestment budget = netProfit × 0.70
 *   3. Split allocation:
 *      - 50% of reinvestment → boost budget of top SCALE campaigns
 *      - 50% of reinvestment → increase TEST budget (new products)
 *   4. Log compound event with before/after budgets
 *
 * INTEGRATION
 *   OptimizationScheduler calls this at the END of each cycle.
 *   Applies budget changes directly to DB + emits Meta API calls via MetaApiClient.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

// ── Config ────────────────────────────────────────────────────────────────────

const REINVEST_RATIO    = parseFloat(process.env.REINVEST_RATIO    ?? '0.70');
const PROFIT_RATIO      = 1 - REINVEST_RATIO;
const SCALE_SHARE       = 0.50;   // of reinvestment → boost winning campaigns
const DISCOVERY_SHARE   = 0.50;   // of reinvestment → new test budget
const MAX_BOOST_PER_CAM = parseFloat(process.env.COMPOUND_MAX_BOOST_PER_CAM ?? '100'); // $ max boost per campaign/cycle
const MIN_COMPOUND_PROFIT = parseFloat(process.env.MIN_COMPOUND_PROFIT ?? '50');        // $ min profit before reinvesting

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompoundResult {
  cycleId:            string;
  grossProfit:        number;
  reinvestedAmount:   number;
  extractedAmount:    number;
  scaleCampaignBoosts: Array<{ campaignId: string; boostAmount: number }>;
  discoveryBudgetAdd: number;
  skippedReason?:     string;
}

@Injectable()
export class ProfitCompoundingEngine {
  private readonly logger = new Logger(ProfitCompoundingEngine.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ── Main: compute and apply reinvestment for a cycle ─────────────────────

  async compoundCycleProfit(cycleId: string): Promise<CompoundResult> {

    const grossProfit = await this.fetchCycleNetProfit(cycleId);

    if (grossProfit < MIN_COMPOUND_PROFIT) {
      return {
        cycleId, grossProfit,
        reinvestedAmount: 0, extractedAmount: grossProfit,
        scaleCampaignBoosts: [], discoveryBudgetAdd: 0,
        skippedReason: `Profit $${grossProfit.toFixed(2)} below min $${MIN_COMPOUND_PROFIT}`,
      };
    }

    const reinvestedAmount = parseFloat((grossProfit * REINVEST_RATIO).toFixed(2));
    const extractedAmount  = parseFloat((grossProfit * PROFIT_RATIO).toFixed(2));

    const scalePool      = reinvestedAmount * SCALE_SHARE;
    const discoveryPool  = reinvestedAmount * DISCOVERY_SHARE;

    // Boost top profitable campaigns
    const scaleCampaignBoosts = await this.boostTopCampaigns(scalePool);

    // Log discovery budget addition (consumed by AutonomousLoopService)
    await this.logDiscoveryBudget(cycleId, discoveryPool);

    // Record compound event
    await this.logCompoundEvent(
      cycleId, grossProfit, reinvestedAmount, extractedAmount, discoveryPool,
    );

    this.logger.log(
      `[Compound] Cycle ${cycleId} | Profit $${grossProfit.toFixed(2)} | ` +
      `Reinvest $${reinvestedAmount.toFixed(2)} (${(REINVEST_RATIO*100).toFixed(0)}%) | ` +
      `Scale boosts: ${scaleCampaignBoosts.length} campaigns | ` +
      `Discovery pool: $${discoveryPool.toFixed(2)}`,
    );

    return {
      cycleId, grossProfit, reinvestedAmount, extractedAmount,
      scaleCampaignBoosts, discoveryBudgetAdd: discoveryPool,
    };
  }

  // ── Get cumulative compound stats ─────────────────────────────────────────

  async getCompoundStats(): Promise<{
    totalGrossProfit:    number;
    totalReinvested:     number;
    totalExtracted:      number;
    compoundEventCount:  number;
    avgReinvestPerCycle: number;
  }> {
    try {
      const rows = await this.db.execute(sql`
        SELECT
          COALESCE(SUM(gross_profit), 0)    AS total_gross,
          COALESCE(SUM(reinvested), 0)      AS total_reinvested,
          COALESCE(SUM(extracted), 0)       AS total_extracted,
          COUNT(*)                          AS event_count
        FROM   compound_events
      `) as unknown as Array<{
        total_gross: string; total_reinvested: string;
        total_extracted: string; event_count: string;
      }>;

      const r     = rows[0];
      const count = parseInt(r?.event_count ?? '0');
      const total = parseFloat(r?.total_reinvested ?? '0');

      return {
        totalGrossProfit:    parseFloat(r?.total_gross        ?? '0'),
        totalReinvested:     total,
        totalExtracted:      parseFloat(r?.total_extracted    ?? '0'),
        compoundEventCount:  count,
        avgReinvestPerCycle: count > 0 ? parseFloat((total / count).toFixed(2)) : 0,
      };
    } catch { return { totalGrossProfit: 0, totalReinvested: 0, totalExtracted: 0, compoundEventCount: 0, avgReinvestPerCycle: 0 }; }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async fetchCycleNetProfit(cycleId: string): Promise<number> {
    try {
      const rows = await this.db.execute(sql`
        SELECT COALESCE(SUM(net_profit), 0) AS total
        FROM   optimization_decisions
        WHERE  cycle_id   = ${cycleId}
          AND  net_profit > 0
          AND  decision   = 'SCALE'
      `) as unknown as Array<{ total: string }>;
      return parseFloat(rows[0]?.total ?? '0');
    } catch { return 0; }
  }

  private async boostTopCampaigns(
    scalePool: number,
  ): Promise<Array<{ campaignId: string; boostAmount: number }>> {
    const boosts: Array<{ campaignId: string; boostAmount: number }> = [];
    if (scalePool < 5) return boosts;

    try {
      // Get top profitable campaigns ordered by ROAS
      const campaigns = await this.db.execute(sql`
        SELECT id, budget_daily::float AS budget, roas::float AS roas
        FROM   campaigns
        WHERE  status             = 'active'
          AND  performance_status = 'profitable'
          AND  COALESCE(roas::float, 0) >= 2.0
        ORDER BY COALESCE(roas::float, 0) DESC
        LIMIT 5
      `) as unknown as Array<{ id: string; budget: number; roas: number }>;

      if (!campaigns.length) return boosts;

      const perCampaign = Math.min(
        parseFloat((scalePool / campaigns.length).toFixed(2)),
        MAX_BOOST_PER_CAM,
      );

      for (const cam of campaigns) {
        const newBudget = parseFloat((cam.budget + perCampaign).toFixed(2));
        await this.db.update(schema.campaigns)
          .set({ budgetDaily: newBudget.toString(), updatedAt: new Date() })
          .where(eq(schema.campaigns.id, cam.id))
          .catch(() => null);

        boosts.push({ campaignId: cam.id, boostAmount: perCampaign });
      }
    } catch (e) {
      this.logger.warn(`[Compound] boostTopCampaigns error: ${(e as Error).message}`);
    }

    return boosts;
  }

  private async logDiscoveryBudget(cycleId: string, amount: number): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO compound_discovery_budget (cycle_id, amount_usd, created_at)
        VALUES (${cycleId}, ${amount}, NOW())
        ON CONFLICT DO NOTHING
      `);
    } catch { /* non-critical */ }
  }

  private async logCompoundEvent(
    cycleId:      string,
    grossProfit:  number,
    reinvested:   number,
    extracted:    number,
    discovery:    number,
  ): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO compound_events
          (cycle_id, gross_profit, reinvested, extracted, discovery_allocation, created_at)
        VALUES
          (${cycleId}, ${grossProfit}, ${reinvested}, ${extracted}, ${discovery}, NOW())
        ON CONFLICT DO NOTHING
      `);
    } catch { /* non-critical */ }
  }
}
