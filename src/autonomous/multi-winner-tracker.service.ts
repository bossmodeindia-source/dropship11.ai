/**
 * MultiWinnerTrackerService — PHASE 3 STEP 1
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 *   Maintain 3–5 ACTIVE winners at all times.
 *   - If winners < 3 → emit signal to increase product discovery rate
 *   - If winners ≥ 5 → emit signal to reduce testing, focus on scaling
 *   - Tracks winner stability (how long each product has been profitable)
 *   - Prevents sudden income drops from single-product dependence
 *
 * WINNER CRITERIA (Phase 3)
 *   ROAS ≥ 2.0 AND netProfit > 0 for ≥ 2 consecutive optimization cycles
 *   i.e. same threshold as SCALE decision in ProfitEngine
 *
 * INTEGRATION
 *   OptimizationScheduler reads winner count after each cycle.
 *   UnifiedCommerceOrchestrator adjusts discovery rate from directive.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WinnerSummary {
  campaignId:     string;
  productId:      string | null;
  productTitle:   string;
  category:       string;
  roas:           number;
  dailyProfit:    number;   // estimated ₹/day
  winStreak:      number;   // consecutive profitable cycles
  budgetDaily:    number;
  status:         'stable' | 'scaling' | 'new';
}

export interface WinnerPortfolio {
  winners:         WinnerSummary[];
  winnerCount:     number;
  directive:       'BOOST_DISCOVERY' | 'REDUCE_TESTING' | 'BALANCED';
  directiveReason: string;
  computedAt:      Date;
}

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_WINNERS = parseInt(process.env.MIN_WINNERS ?? '3', 10);
const MAX_WINNERS = parseInt(process.env.MAX_WINNERS ?? '5', 10);
const WINNER_ROAS_MIN   = parseFloat(process.env.WINNER_ROAS_MIN   ?? '2.0');
const WINNER_STREAK_MIN = parseInt(process.env.WINNER_STREAK_MIN   ?? '2',   10);

@Injectable()
export class MultiWinnerTrackerService {
  private readonly logger = new Logger(MultiWinnerTrackerService.name);
  private lastPortfolio: WinnerPortfolio | null = null;

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ── Main: compute current winner portfolio ────────────────────────────────

  async computePortfolio(): Promise<WinnerPortfolio> {
    const winners = await this.fetchActiveWinners();
    const count   = winners.length;

    let directive: WinnerPortfolio['directive'];
    let directiveReason: string;

    if (count < MIN_WINNERS) {
      directive       = 'BOOST_DISCOVERY';
      directiveReason = `Only ${count} winners active (min: ${MIN_WINNERS}). Increase product discovery rate.`;
    } else if (count >= MAX_WINNERS) {
      directive       = 'REDUCE_TESTING';
      directiveReason = `${count} winners active (max: ${MAX_WINNERS}). Focus budget on scaling, reduce new tests.`;
    } else {
      directive       = 'BALANCED';
      directiveReason = `${count} winners active. Balanced mode: maintain discovery + scale.`;
    }

    const portfolio: WinnerPortfolio = {
      winners,
      winnerCount:  count,
      directive,
      directiveReason,
      computedAt:   new Date(),
    };

    this.lastPortfolio = portfolio;

    this.logger.log(
      `[MultiWinner] ${count} winners | Directive: ${directive} | ${directiveReason}`,
    );

    return portfolio;
  }

  getLastPortfolio(): WinnerPortfolio | null {
    return this.lastPortfolio;
  }

  // ── Mark a campaign as confirmed winner (called from OptimizationScheduler) ─

  async recordWinCycle(campaignId: string): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO winner_streaks (campaign_id, streak, last_win_at)
        VALUES (${campaignId}, 1, NOW())
        ON CONFLICT (campaign_id) DO UPDATE
          SET streak       = winner_streaks.streak + 1,
              last_win_at  = NOW()
      `);
    } catch { /* non-critical */ }
  }

  async resetWinStreak(campaignId: string): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO winner_streaks (campaign_id, streak, last_win_at)
        VALUES (${campaignId}, 0, NOW())
        ON CONFLICT (campaign_id) DO UPDATE SET streak = 0
      `);
    } catch { /* non-critical */ }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async fetchActiveWinners(): Promise<WinnerSummary[]> {
    try {
      const rows = await this.db.execute(sql`
        SELECT
          c.id                                      AS campaign_id,
          c.product_id,
          COALESCE(p.title, 'Unknown')              AS product_title,
          COALESCE(p.category, 'general')           AS category,
          COALESCE(c.roas::float, 0)                AS roas,
          COALESCE(c.budget_daily::float, 0)        AS budget_daily,
          COALESCE(ws.streak, 0)                    AS win_streak,
          c.performance_status
        FROM   campaigns c
        LEFT JOIN products      p  ON p.id  = c.product_id
        LEFT JOIN winner_streaks ws ON ws.campaign_id = c.id
        WHERE  c.status           = 'active'
          AND  c.performance_status = 'profitable'
          AND  COALESCE(c.roas::float, 0)  >= ${WINNER_ROAS_MIN}
          AND  COALESCE(ws.streak, 0)      >= ${WINNER_STREAK_MIN}
        ORDER BY COALESCE(c.roas::float, 0) DESC
        LIMIT 20
      `) as unknown as Array<{
        campaign_id: string; product_id: string | null;
        product_title: string; category: string;
        roas: number; budget_daily: number; win_streak: number;
        performance_status: string;
      }>;

      return rows.map(r => ({
        campaignId:   r.campaign_id,
        productId:    r.product_id,
        productTitle: r.product_title,
        category:     r.category,
        roas:         r.roas,
        dailyProfit:  (r.roas - 1) * r.budget_daily,
        winStreak:    r.win_streak,
        budgetDaily:  r.budget_daily,
        status:       r.win_streak >= 4 ? 'stable' : r.win_streak >= 2 ? 'new' : 'new',
      }));
    } catch (e) {
      this.logger.warn(`[MultiWinner] fetchActiveWinners error: ${(e as Error).message}`);
      return [];
    }
  }
}
