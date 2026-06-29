/**
 * GlobalPerformanceService — Empire Metrics Tracker
 *
 * Tracks:
 *   - total profit
 *   - ROI trend
 *   - growth rate
 *   - win/loss rate
 *   - actual vs predicted ROAS
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Pool } from 'pg';

export interface EmpireSnapshot {
  totalCapital:     number;
  totalProfit:      number;
  totalRevenue:     number;
  roi:              number;
  growthRate:       number; // % vs previous snapshot
  winRate:          number; // %
  lossRate:         number; // %
  activeStores:     number;
  actualRoas:       number;
  predictedRoas:    number;
  roasDelta:        number; // actual - predicted
  capitalGrowthCurve: number[]; // last 10 snapshots
}

export interface CycleRecord {
  cycleId:        string;
  capitalBefore:  number;
  capitalAfter:   number;
  reinvested:     number;
  reserved:       number;
  strategyMode:   string;
}

@Injectable()
export class GlobalPerformanceService {
  private readonly logger = new Logger(GlobalPerformanceService.name);

  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  async getSnapshot(): Promise<EmpireSnapshot> {
    try {
      const [capital, roas, stores, rates, curve] = await Promise.all([
        this.fetchCapital(),
        this.fetchRoasMetrics(),
        this.fetchStoreCount(),
        this.fetchWinLossRates(),
        this.fetchGrowthCurve(),
      ]);

      const growth = curve.length >= 2
        ? ((curve[curve.length - 1] - curve[curve.length - 2]) / (curve[curve.length - 2] || 1)) * 100
        : 0;

      return {
        totalCapital:       capital.capital,
        totalProfit:        capital.profit,
        totalRevenue:       capital.revenue,
        roi:                capital.revenue > 0 ? (capital.profit / capital.revenue) * 100 : 0,
        growthRate:         growth,
        winRate:            rates.winRate,
        lossRate:           rates.lossRate,
        activeStores:       stores,
        actualRoas:         roas.actual,
        predictedRoas:      roas.predicted,
        roasDelta:          roas.actual - roas.predicted,
        capitalGrowthCurve: curve,
      };
    } catch (err) {
      this.logger.warn(`[GlobalPerf] Snapshot failed: ${(err as Error).message}`);
      return this.emptySnapshot();
    }
  }

  async recordCycle(record: CycleRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO empire_cycles
           (cycle_id, capital_before, capital_after, reinvested, reserved, strategy_mode, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          record.cycleId,
          record.capitalBefore,
          record.capitalAfter,
          record.reinvested,
          record.reserved,
          record.strategyMode,
        ],
      );
    } catch (err) {
      this.logger.warn(`[GlobalPerf] recordCycle failed: ${(err as Error).message}`);
    }
  }

  // ── Private data fetchers ──────────────────────────────────────────────────

  private async fetchCapital(): Promise<{ capital: number; profit: number; revenue: number }> {
    const { rows } = await this.pool.query(`
      SELECT
        COALESCE(SUM(balance), 0)  AS capital,
        COALESCE(SUM(profit),  0)  AS profit,
        COALESCE(SUM(revenue), 0)  AS revenue
      FROM store_financials
      WHERE active = true
    `);
    return rows[0] ?? { capital: 0, profit: 0, revenue: 0 };
  }

  private async fetchRoasMetrics(): Promise<{ actual: number; predicted: number }> {
    const { rows } = await this.pool.query(`
      SELECT
        COALESCE(AVG(actual_roas),    0) AS actual,
        COALESCE(AVG(predicted_roas), 0) AS predicted
      FROM campaign_roas_tracking
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    return rows[0] ?? { actual: 0, predicted: 0 };
  }

  private async fetchStoreCount(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM stores WHERE status = 'active'`,
    );
    return parseInt(rows[0]?.cnt ?? '0', 10);
  }

  private async fetchWinLossRates(): Promise<{ winRate: number; lossRate: number }> {
    const { rows } = await this.pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END), 0) AS losses,
        COUNT(*) AS total
      FROM campaign_outcomes
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    const { wins, losses, total } = rows[0] ?? { wins: 0, losses: 0, total: 1 };
    const t = parseInt(total, 10) || 1;
    return {
      winRate:  (parseInt(wins, 10) / t) * 100,
      lossRate: (parseInt(losses, 10) / t) * 100,
    };
  }

  private async fetchGrowthCurve(): Promise<number[]> {
    const { rows } = await this.pool.query(`
      SELECT capital_after
      FROM empire_cycles
      ORDER BY recorded_at DESC
      LIMIT 10
    `);
    return rows.map((r: any) => parseFloat(r.capital_after ?? '0')).reverse();
  }

  private emptySnapshot(): EmpireSnapshot {
    return {
      totalCapital: 0, totalProfit: 0, totalRevenue: 0,
      roi: 0, growthRate: 0, winRate: 0, lossRate: 0,
      activeStores: 0, actualRoas: 0, predictedRoas: 0,
      roasDelta: 0, capitalGrowthCurve: [],
    };
  }
}
