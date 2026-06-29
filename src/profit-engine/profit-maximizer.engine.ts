/**
 * ProfitMaximizerEngine — V31 Requirements 1 & 2
 *
 * Req 1 — ROI-BASED SCALING:
 *   Scale ONLY when:  expected_ROI > ROI_THRESHOLD
 *   ROI = (revenue - spend) / spend
 *
 * Req 2 — RISK-ADJUSTED SCALING:
 *   risk_score = (VARIANCE_W × volatility) + (DRAWDOWN_W × drawdown) + (SUPPLIER_W × supplierRisk)
 *   gate_value  = expected_value / risk_score
 *   Block SCALE if gate_value < RISK_ADJUSTED_EV_FLOOR
 *
 * Scale factor is dynamically computed from:
 *   base_factor × roi_boost × (1 / (1 + risk_score)) × winner_streak_bonus
 *
 * All thresholds are env-configurable; defaults are profitable-but-safe values.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { Inject } from '@nestjs/common';
import { PROFIT_ENGINE_TOKENS } from './profit-engine.module';
import {
  ROIGateInput,
  ROIGateResult,
} from './profit-engine-types';

// ── Config ────────────────────────────────────────────────────────────────────
const ROI_THRESHOLD         = parseFloat(process.env.PE_ROI_THRESHOLD          ?? '0.15');  // 15% minimum ROI to scale
const RISK_ADJUSTED_EV_FLOOR= parseFloat(process.env.PE_RISK_ADJUSTED_EV_FLOOR ?? '0.10');  // min EV/risk_score
const VARIANCE_W            = parseFloat(process.env.PE_VARIANCE_WEIGHT         ?? '0.40');
const DRAWDOWN_W            = parseFloat(process.env.PE_DRAWDOWN_WEIGHT         ?? '0.35');
const SUPPLIER_W            = parseFloat(process.env.PE_SUPPLIER_WEIGHT         ?? '0.25');
const BASE_SCALE_FACTOR     = parseFloat(process.env.PE_BASE_SCALE_FACTOR       ?? '1.20');
const MAX_SCALE_FACTOR      = parseFloat(process.env.PE_MAX_SCALE_FACTOR        ?? '2.00');
const EV_WINDOW             = parseInt  (process.env.PE_EV_WINDOW               ?? '15',    10);
const ROI_BOOST_CAP         = parseFloat(process.env.PE_ROI_BOOST_CAP           ?? '1.50');  // cap ROI-based uplift

@Injectable()
export class ProfitMaximizerEngine {
  private readonly logger = new Logger(ProfitMaximizerEngine.name);

  constructor(
    @Inject(PROFIT_ENGINE_TOKENS.PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Primary gate: should this campaign scale, and by how much?
   *
   * Returns `allowed=false` if ROI or risk-adjusted EV fail thresholds.
   * Returns `allowed=true` with a `scaleFactor` to apply to current budget.
   */
  async evaluate(input: ROIGateInput): Promise<ROIGateResult> {
    const roi = this.computeROI(input.revenue, input.spend);

    // ── Req 1: ROI gate ───────────────────────────────────────────────────
    if (roi < ROI_THRESHOLD) {
      this.logger.log(
        `[ProfitMaximizer] ROI_BLOCK campaign=${input.campaignId} ` +
        `roi=${roi.toFixed(3)} < threshold=${ROI_THRESHOLD}`,
      );
      return {
        allowed:        false,
        roi,
        riskScore:      0,
        riskAdjustedEV: 0,
        scaleFactor:    1.0,
        phase:          roi < 0 ? 'CUT' : 'HOLD',
        blockReason:    `ROI=${(roi * 100).toFixed(1)}% below threshold ${(ROI_THRESHOLD * 100).toFixed(0)}%`,
      };
    }

    // ── Req 2: Risk score ─────────────────────────────────────────────────
    const riskScore = this.computeRiskScore(
      input.volatility, input.drawdownPct, input.supplierRisk,
    );

    // Fetch historical EV from profit_tracking
    const historicalEV = await this.computeHistoricalEV(input.campaignId);
    const expectedValue = historicalEV ?? (roi * input.spend * 0.8); // fallback: 80% of current profit

    const riskAdjustedEV = riskScore > 0 ? expectedValue / riskScore : expectedValue;

    if (riskAdjustedEV < RISK_ADJUSTED_EV_FLOOR) {
      this.logger.log(
        `[ProfitMaximizer] RISK_BLOCK campaign=${input.campaignId} ` +
        `riskAdjEV=${riskAdjustedEV.toFixed(3)} < floor=${RISK_ADJUSTED_EV_FLOOR} ` +
        `riskScore=${riskScore.toFixed(3)}`,
      );
      return {
        allowed:        false,
        roi,
        riskScore,
        riskAdjustedEV,
        scaleFactor:    1.0,
        phase:          'HOLD',
        blockReason:
          `RiskAdjustedEV=${riskAdjustedEV.toFixed(3)} < floor=${RISK_ADJUSTED_EV_FLOOR} ` +
          `(riskScore=${riskScore.toFixed(2)} EV=${expectedValue.toFixed(2)})`,
      };
    }

    // ── Compute dynamic scale factor ───────────────────────────────────────
    const scaleFactor = this.computeScaleFactor(roi, riskScore, input.consecutiveWins);

    const phase = scaleFactor >= 1.9 ? 'ACCELERATION'
      : scaleFactor >= 1.4 ? 'ACCELERATION'
      : 'NORMAL';

    this.logger.log(
      `[ProfitMaximizer] ALLOWED campaign=${input.campaignId} ` +
      `roi=${(roi * 100).toFixed(1)}% riskScore=${riskScore.toFixed(2)} ` +
      `riskAdjEV=${riskAdjustedEV.toFixed(3)} scaleFactor=${scaleFactor.toFixed(2)} phase=${phase}`,
    );

    // Persist gate result for audit
    await this.persistGateResult(input.campaignId, roi, riskScore, riskAdjustedEV, scaleFactor, true);

    return {
      allowed: true,
      roi,
      riskScore,
      riskAdjustedEV,
      scaleFactor,
      phase,
    };
  }

  /**
   * Batch evaluation: evaluate all campaigns and rank by profit potential.
   * Used by GlobalCapitalOptimizer for cross-campaign allocation decisions.
   */
  async rankByPotential(
    inputs: ROIGateInput[],
  ): Promise<Array<ROIGateResult & { campaignId: string }>> {
    const results = await Promise.all(
      inputs.map(async i => ({ campaignId: i.campaignId, ...(await this.evaluate(i)) })),
    );
    // Sort: allowed first, then by riskAdjustedEV desc
    return results.sort((a, b) => {
      if (a.allowed !== b.allowed) return a.allowed ? -1 : 1;
      return b.riskAdjustedEV - a.riskAdjustedEV;
    });
  }

  // ── Computation helpers ────────────────────────────────────────────────────

  /** ROI = (revenue - spend) / spend. Clamped to [-1, 10]. */
  computeROI(revenue: number, spend: number): number {
    if (spend <= 0) return 0;
    return Math.max(-1, Math.min(10, (revenue - spend) / spend));
  }

  /**
   * risk_score = (VARIANCE_W × volatility) + (DRAWDOWN_W × drawdown) + (SUPPLIER_W × supplierRisk)
   * All inputs 0–1. Output 0–1.
   * Clamped to [0.01, 1] to avoid division by zero.
   */
  computeRiskScore(volatility: number, drawdown: number, supplierRisk: number): number {
    const raw = (VARIANCE_W * volatility) + (DRAWDOWN_W * drawdown) + (SUPPLIER_W * supplierRisk);
    return Math.max(0.01, Math.min(1.0, raw));
  }

  /**
   * Scale factor computation:
   *   base × roi_boost × risk_dampener × streak_bonus
   *
   * roi_boost:     log-linear: 1 + (roi / threshold - 1) capped at ROI_BOOST_CAP
   * risk_dampener: 1 / (1 + riskScore)  — higher risk → smaller multiplier
   * streak_bonus:  +0.05 per consecutive win beyond 2, capped at +0.30
   */
  computeScaleFactor(roi: number, riskScore: number, consecutiveWins: number): number {
    const roiBoost = Math.min(
      ROI_BOOST_CAP,
      1 + Math.log1p(Math.max(0, roi / ROI_THRESHOLD - 1)) * 0.5,
    );
    const riskDampener = 1 / (1 + riskScore);
    const streakBonus  = Math.min(0.30, Math.max(0, (consecutiveWins - 2) * 0.05));

    const raw = BASE_SCALE_FACTOR * roiBoost * riskDampener * (1 + streakBonus);
    return Math.max(1.0, Math.min(MAX_SCALE_FACTOR, raw));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async computeHistoricalEV(campaignId: string): Promise<number | null> {
    try {
      const { rows } = await this.pool.query<{ profit: number }>(
        `SELECT profit FROM profit_tracking
         WHERE campaign_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [campaignId, EV_WINDOW],
      );
      if (rows.length < 3) return null;

      const profits   = rows.map(r => Number(r.profit));
      const wins      = profits.filter(p => p > 0);
      const losses    = profits.filter(p => p <= 0).map(Math.abs);
      const pWin      = wins.length / profits.length;
      const eProfitW  = wins.length   ? wins.reduce((a, v) => a + v, 0) / wins.length   : 0;
      const eLossW    = losses.length ? losses.reduce((a, v) => a + v, 0) / losses.length : 0;

      return (pWin * eProfitW) - ((1 - pWin) * eLossW);
    } catch {
      return null;
    }
  }

  private async persistGateResult(
    campaignId:    string,
    roi:           number,
    riskScore:     number,
    riskAdjustedEV: number,
    scaleFactor:   number,
    allowed:       boolean,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO pe_profit_gate_log
         (campaign_id, roi, risk_score, risk_adjusted_ev, scale_factor, allowed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [campaignId, roi, riskScore, riskAdjustedEV, scaleFactor, allowed],
    ).catch(e => this.logger.warn(`ProfitGate log failed: ${e.message}`));
  }
}
