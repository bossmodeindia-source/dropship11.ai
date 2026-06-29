/**
 * GlobalCapitalOptimizer — V31 Requirement 3
 *
 * Req 3 — GLOBAL CAPITAL OPTIMIZER:
 *   Allocates capital across ALL stores based on:
 *     - ROI (return per unit spend)
 *     - Stability (1 - volatility, smoothed)
 *     - Growth velocity (ΔProfit / time, normalized)
 *
 * Allocation weight (Sharpe-inspired):
 *   sharpe_score = (ROI × stability × growth_velocity) / risk_score
 *   weight_i = sharpe_score_i / Σ sharpe_score_j
 *
 * Hard invariants:
 *   - Max per-store pct: GCO_MAX_STORE_PCT (default 45%)
 *   - Min reserve: GCO_RESERVE_PCT (default 15%)
 *   - Min per-store if active: GCO_MIN_STORE_USD (default $100)
 *   - Negative-ROI stores get 0 allocation (reclaim capital)
 *
 * Re-balancing triggers:
 *   - Cron: every GCO_REBALANCE_INTERVAL_MIN minutes
 *   - On-demand: called by GlobalProfitTargetService when off-track
 *   - On SCALE: if a store is under-allocated vs its sharpe weight
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PROFIT_ENGINE_TOKENS } from './profit-engine.module';
import {
  StoreMetrics,
  StoreAllocation,
  GlobalAllocationPlan,
} from './profit-engine-types';
import { ProfitMaximizerEngine } from './profit-maximizer.engine';

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_STORE_PCT             = parseFloat(process.env.GCO_MAX_STORE_PCT          ?? '0.45');
const RESERVE_PCT               = parseFloat(process.env.GCO_RESERVE_PCT            ?? '0.15');
const MIN_STORE_USD             = parseFloat(process.env.GCO_MIN_STORE_USD          ?? '100');
const ROI_WEIGHT                = parseFloat(process.env.GCO_ROI_WEIGHT             ?? '0.45');
const STABILITY_WEIGHT          = parseFloat(process.env.GCO_STABILITY_WEIGHT       ?? '0.30');
const GROWTH_WEIGHT             = parseFloat(process.env.GCO_GROWTH_WEIGHT          ?? '0.25');
const REBALANCE_INTERVAL_MIN    = parseInt  (process.env.GCO_REBALANCE_INTERVAL_MIN ?? '60', 10);
const VELOCITY_LOOKBACK_HOURS   = parseInt  (process.env.GCO_VELOCITY_LOOKBACK_HOURS ?? '24', 10);

@Injectable()
export class GlobalCapitalOptimizer {
  private readonly logger = new Logger(GlobalCapitalOptimizer.name);
  private lastPlan: GlobalAllocationPlan | null = null;

  constructor(
    @Inject(PROFIT_ENGINE_TOKENS.PG_POOL) private readonly pool: Pool,
    private readonly profitMaximizer: ProfitMaximizerEngine,
  ) {}

  // ── Scheduled rebalance ───────────────────────────────────────────────────

  @Cron(`0 */${REBALANCE_INTERVAL_MIN} * * * *`)
  async scheduledRebalance(): Promise<void> {
    try {
      this.logger.log('[GCO] Scheduled rebalance triggered');
      await this.computeAndEmitPlan();
    } catch (err: any) {
      this.logger.error(`[GCO] Scheduled rebalance failed: ${err.message}`);
    }
  }

  // ── Core allocation logic ─────────────────────────────────────────────────

  /**
   * Compute the optimal global allocation plan across all active stores.
   * Returns the plan — callers decide whether to execute capital movements.
   */
  async computeOptimalAllocation(totalCapital?: number): Promise<GlobalAllocationPlan> {
    const capital = totalCapital ?? await this.fetchTotalGlobalCapital();
    const deployable = capital * (1 - RESERVE_PCT);

    // Fetch store metrics
    const storeMetrics = await this.fetchStoreMetrics();

    if (storeMetrics.length === 0) {
      return {
        allocations:    [],
        totalCapital:   capital,
        reservedCapital: capital,
        computedAt:     new Date(),
        objective:      0,
      };
    }

    // Filter out negative-ROI stores (reclaim their capital)
    const viable   = storeMetrics.filter(s => s.roi >= 0);
    const negative  = storeMetrics.filter(s => s.roi < 0);

    if (negative.length > 0) {
      this.logger.warn(
        `[GCO] ${negative.length} negative-ROI stores → zero allocation: ` +
        negative.map(s => `${s.storeId}(ROI=${(s.roi * 100).toFixed(1)}%)`).join(', '),
      );
    }

    // Compute Sharpe-inspired weights
    const weights = this.computeWeights(viable);
    const totalWeight = [...weights.values()].reduce((a, w) => a + w, 0);

    // Build allocation plan
    const allocations: StoreAllocation[] = [];
    let totalObjective = 0;

    for (const store of viable) {
      const weight    = weights.get(store.storeId) ?? 0;
      const rawPct    = totalWeight > 0 ? weight / totalWeight : 1 / viable.length;
      const clampPct  = Math.min(MAX_STORE_PCT, rawPct);
      const target    = Math.max(MIN_STORE_USD, deployable * clampPct);
      const delta     = target - store.allocatedCapital;

      allocations.push({
        storeId:       store.storeId,
        targetCapital: target,
        delta,
        weight,
        reason:
          `roi=${(store.roi * 100).toFixed(1)}% ` +
          `stability=${store.stability.toFixed(2)} ` +
          `velocity=${store.growthVelocity.toFixed(3)} ` +
          `sharpe=${weight.toFixed(3)}`,
      });

      totalObjective += store.roi * target;
    }

    // Negative-ROI stores get reclaim allocations (delta = -allocatedCapital)
    for (const store of negative) {
      allocations.push({
        storeId:       store.storeId,
        targetCapital: 0,
        delta:         -store.allocatedCapital,
        weight:        0,
        reason:        `negative ROI=${(store.roi * 100).toFixed(1)}% — reclaim capital`,
      });
    }

    const plan: GlobalAllocationPlan = {
      allocations,
      totalCapital:    capital,
      reservedCapital: capital - allocations.filter(a => a.delta > 0).reduce((s, a) => s + a.targetCapital, 0),
      computedAt:      new Date(),
      objective:       totalObjective,
    };

    this.lastPlan = plan;
    await this.persistPlan(plan);

    this.logger.log(
      `[GCO] Plan computed: stores=${viable.length} deployable=₹${deployable.toFixed(0)} ` +
      `objective=₹${totalObjective.toFixed(0)} reserved=₹${plan.reservedCapital.toFixed(0)}`,
    );

    return plan;
  }

  /** Latest cached plan, for fast reads */
  getLastPlan(): GlobalAllocationPlan | null {
    return this.lastPlan;
  }

  /**
   * Check if a specific store is under-allocated vs its optimal weight.
   * Used by V30 kernel to decide whether to inject more capital on SCALE.
   */
  async isUnderAllocated(storeId: string): Promise<{ under: boolean; delta: number }> {
    const plan = this.lastPlan ?? await this.computeOptimalAllocation();
    const alloc = plan.allocations.find(a => a.storeId === storeId);
    if (!alloc) return { under: false, delta: 0 };
    return { under: alloc.delta > MIN_STORE_USD, delta: alloc.delta };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Sharpe-inspired weight: (ROI×roi_w + stability×stab_w + velocity×vel_w) / riskScore */
  private computeWeights(stores: StoreMetrics[]): Map<string, number> {
    const weights = new Map<string, number>();
    for (const s of stores) {
      const composite = (
        ROI_WEIGHT       * Math.max(0, s.roi) +
        STABILITY_WEIGHT * s.stability +
        GROWTH_WEIGHT    * Math.max(0, s.growthVelocity)
      );
      const risk = this.profitMaximizer.computeRiskScore(
        1 - s.stability,  // volatility ≈ 1 - stability
        Math.max(0, -s.roi),  // drawdown proxy
        s.riskScore,
      );
      weights.set(s.storeId, composite / Math.max(0.01, risk));
    }
    return weights;
  }

  private async fetchTotalGlobalCapital(): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: number }>(
        `SELECT COALESCE(SUM(allocated_capital_usd), 0) AS total FROM stores WHERE status = 'ACTIVE'`,
      );
      return Number(rows[0]?.total ?? 1000);
    } catch { return 1000; }
  }

  private async fetchStoreMetrics(): Promise<StoreMetrics[]> {
    try {
      interface StoreMetricRow {
        store_id: string; roi: string | null; risk_score: string | null;
        allocated_capital: string | null; profit: string | null;
        volatility: string; growth_velocity: string; consecutive_wins: string;
      }
      const { rows } = await this.pool.query<StoreMetricRow>(`
        SELECT
          s.id           AS store_id,
          s.roi_30d      AS roi,
          s.risk_score,
          s.allocated_capital_usd AS allocated_capital,
          s.total_profit_usd      AS profit,
          COALESCE(v.volatility, 0.3) AS volatility,
          COALESCE(v.growth_velocity, 0) AS growth_velocity,
          COALESCE(v.consecutive_wins, 0) AS consecutive_wins
        FROM stores s
        LEFT JOIN (
          SELECT
            store_id,
            STDDEV(profit) / NULLIF(ABS(AVG(profit)), 0) AS volatility,
            (MAX(profit) - MIN(profit)) / NULLIF(NULLIF(COUNT(*), 0), 0) AS growth_velocity,
            COUNT(*) FILTER (WHERE profit > 0) AS consecutive_wins
          FROM pe_store_profit_snapshots
          WHERE snapshot_at > NOW() - INTERVAL '${VELOCITY_LOOKBACK_HOURS} hours'
          GROUP BY store_id
        ) v ON v.store_id = s.id
        WHERE s.status = 'ACTIVE'
      `);

      return rows.map(r => ({
        storeId:          r.store_id,
        roi:              Number(r.roi ?? 0),
        stability:        Math.max(0, 1 - Math.min(1, Number(r.volatility ?? 0.3))),
        growthVelocity:   Math.max(-1, Math.min(2, Number(r.growth_velocity ?? 0))),
        allocatedCapital: Number(r.allocated_capital ?? 0),
        profit:           Number(r.profit ?? 0),
        riskScore:        Number(r.risk_score ?? 0.5),
        consecutiveWins:  Number(r.consecutive_wins ?? 0),
      }));
    } catch (e: any) {
      this.logger.warn(`[GCO] fetchStoreMetrics failed: ${e.message}`);
      return [];
    }
  }

  private async computeAndEmitPlan(): Promise<void> {
    const plan = await this.computeOptimalAllocation();
    // Emit significant rebalances as log entries for downstream consumption
    const significant = plan.allocations.filter(a => Math.abs(a.delta) > MIN_STORE_USD);
    if (significant.length > 0) {
      this.logger.log(
        `[GCO] ${significant.length} rebalances needed: ` +
        significant.map(a => `${a.storeId}(Δ₹${a.delta.toFixed(0)})`).join(', '),
      );
    }
  }

  private async persistPlan(plan: GlobalAllocationPlan): Promise<void> {
    const planId = uuidv4();
    try {
      await this.pool.query(
        `INSERT INTO pe_global_allocation_plans
           (plan_id, total_capital, reserved_capital, objective, allocation_count, computed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [planId, plan.totalCapital, plan.reservedCapital, plan.objective, plan.allocations.length],
      );
      for (const a of plan.allocations) {
        await this.pool.query(
          `INSERT INTO pe_global_allocation_entries
             (plan_id, store_id, target_capital, delta, weight, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [planId, a.storeId, a.targetCapital, a.delta, a.weight, a.reason],
        ).catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`[GCO] Persist plan failed: ${e.message}`);
    }
  }
}
