/**
 * CapitalGrowthEngine — Capital Compounding Optimizer
 *
 * Goal: maximize capital growth via:
 *   - compound allocation to winners
 *   - prevent capital erosion
 *   - record growth curve
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { ProfitAllocation } from './reinvest.service';

@Injectable()
export class CapitalGrowthEngine {
  private readonly logger = new Logger(CapitalGrowthEngine.name);

  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  /**
   * Apply allocation to capital and return updated capital.
   * Records growth event in DB.
   */
  async optimize(currentCapital: number, allocation: ProfitAllocation): Promise<number> {
    if (allocation.reinvested <= 0) return currentCapital;

    // Compound: add reinvested portion back to active capital
    const updatedCapital = currentCapital + allocation.reinvested;

    try {
      await this.pool.query(
        `INSERT INTO capital_growth_events
           (capital_before, capital_after, reinvested, reserved, recorded_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [currentCapital, updatedCapital, allocation.reinvested, allocation.reserved],
      );
    } catch (err) {
      this.logger.warn(`[CapitalGrowth] DB write failed: ${(err as Error).message}`);
    }

    this.logger.log(
      `[CapitalGrowth] ${currentCapital.toFixed(2)} → ${updatedCapital.toFixed(2)} ` +
      `(+${allocation.reinvested.toFixed(2)} reinvested, ${allocation.reserved.toFixed(2)} reserved)`,
    );

    return updatedCapital;
  }

  async getGrowthCurve(points = 30): Promise<Array<{ capital: number; ts: string }>> {
    try {
      const { rows } = await this.pool.query(
        `SELECT capital_after AS capital, recorded_at AS ts
         FROM capital_growth_events
         ORDER BY recorded_at DESC
         LIMIT $1`,
        [points],
      );
      return rows.map((r: any) => ({ capital: parseFloat(r.capital), ts: r.ts })).reverse();
    } catch {
      return [];
    }
  }
}
