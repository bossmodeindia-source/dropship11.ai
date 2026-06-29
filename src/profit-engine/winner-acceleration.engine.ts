/**
 * WinnerAccelerationEngine — V31 Requirement 4
 *
 * Req 4 — WINNER ACCELERATION ENGINE:
 *   If campaign shows consistent profitability:
 *     2  consecutive wins → 1.2× multiplier  (WARM phase)
 *     4  consecutive wins → 1.5× multiplier  (HOT phase)
 *     7+ consecutive wins → 2.0× multiplier  (PEAK phase)
 *   If losing:
 *     Slow scaling (multiplier stays at 1.0) OR hold (no budget increase)
 *
 * Acceleration cooldown: prevents double-acceleration within COOLDOWN_MINUTES.
 * Budget ceiling: ACCEL_BUDGET_CAP_INR per campaign (hard ceiling regardless of multiplier).
 * Acceleration resets to BASE on any loss event.
 *
 * Budget formula:
 *   new_budget = min(current_budget × multiplier, ACCEL_BUDGET_CAP_INR)
 *
 * State is persisted in pe_acceleration_state table for crash recovery.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PROFIT_ENGINE_TOKENS } from './profit-engine.module';
import {
  AccelerationPhase,
  AccelerationState,
  AccelerationDecision,
} from './profit-engine-types';

// ── Config ────────────────────────────────────────────────────────────────────
const WARM_WINS_THRESHOLD  = parseInt  (process.env.ACCEL_WARM_WINS     ?? '2',       10);
const HOT_WINS_THRESHOLD   = parseInt  (process.env.ACCEL_HOT_WINS      ?? '4',       10);
const PEAK_WINS_THRESHOLD  = parseInt  (process.env.ACCEL_PEAK_WINS     ?? '7',       10);
const WARM_MULTIPLIER      = parseFloat(process.env.ACCEL_WARM_MULT     ?? '1.20');
const HOT_MULTIPLIER       = parseFloat(process.env.ACCEL_HOT_MULT      ?? '1.50');
const PEAK_MULTIPLIER      = parseFloat(process.env.ACCEL_PEAK_MULT     ?? '2.00');
const SLOW_MULTIPLIER      = parseFloat(process.env.ACCEL_SLOW_MULT     ?? '1.05'); // for weak/uncertain
const COOLDOWN_MINUTES     = parseInt  (process.env.ACCEL_COOLDOWN_MIN  ?? '30',      10);
const BUDGET_CAP_INR       = parseFloat(process.env.ACCEL_BUDGET_CAP_INR ?? '50000');

// Phase → wins threshold mapping (sorted desc for lookup)
const PHASE_MAP: Array<{ wins: number; phase: AccelerationPhase; multiplier: number }> = [
  { wins: PEAK_WINS_THRESHOLD, phase: 'PEAK',  multiplier: PEAK_MULTIPLIER },
  { wins: HOT_WINS_THRESHOLD,  phase: 'HOT',   multiplier: HOT_MULTIPLIER  },
  { wins: WARM_WINS_THRESHOLD, phase: 'WARM',  multiplier: WARM_MULTIPLIER },
  { wins: 0,                   phase: 'BASE',  multiplier: 1.0             },
];

@Injectable()
export class WinnerAccelerationEngine {
  private readonly logger = new Logger(WinnerAccelerationEngine.name);

  /** In-memory state cache: campaignId → AccelerationState */
  private readonly stateCache = new Map<string, AccelerationState>();

  constructor(
    @Inject(PROFIT_ENGINE_TOKENS.PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Evaluate whether to accelerate this campaign's budget.
   *
   * @param campaignId  The campaign being evaluated
   * @param currentBudget  Current INR budget
   * @param consecutiveWins  Consecutive profitable cycles
   * @param consecutiveLosses  Consecutive losing cycles (triggers reset)
   * @param roi  Current ROI (negative = no acceleration)
   */
  async evaluate(
    campaignId:       string,
    currentBudget:    number,
    consecutiveWins:  number,
    consecutiveLosses: number,
    roi:              number,
  ): Promise<AccelerationDecision> {
    // ── Loss: reset acceleration state ────────────────────────────────────
    if (consecutiveLosses > 0 || roi < 0) {
      await this.resetState(campaignId);
      return {
        campaignId,
        newBudget:  currentBudget,
        oldBudget:  currentBudget,
        multiplier: 1.0,
        phase:      'BASE',
        applied:    false,
        reason:     `No acceleration: consecutiveLosses=${consecutiveLosses} roi=${(roi * 100).toFixed(1)}%`,
      };
    }

    // ── Weak campaign (1 win, uncertain): slow scale only ─────────────────
    if (consecutiveWins < WARM_WINS_THRESHOLD) {
      return {
        campaignId,
        newBudget:  Math.min(BUDGET_CAP_INR, currentBudget * SLOW_MULTIPLIER),
        oldBudget:  currentBudget,
        multiplier: SLOW_MULTIPLIER,
        phase:      'BASE',
        applied:    true,
        reason:     `Slow scale: wins=${consecutiveWins} < warm_threshold=${WARM_WINS_THRESHOLD}`,
      };
    }

    // ── Determine target phase ─────────────────────────────────────────────
    const targetPhase = this.resolvePhase(consecutiveWins);

    // ── Cooldown check ─────────────────────────────────────────────────────
    const state = await this.getOrLoadState(campaignId);
    const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
    const sinceLastMs = Date.now() - state.lastAccelerationAt.getTime();

    if (state.phase === targetPhase.phase && sinceLastMs < cooldownMs) {
      // Already at this phase, cooldown still active — hold budget
      return {
        campaignId,
        newBudget:  currentBudget,
        oldBudget:  currentBudget,
        multiplier: targetPhase.multiplier,
        phase:      targetPhase.phase,
        applied:    false,
        reason:
          `Cooldown active: phase=${targetPhase.phase} ` +
          `remaining=${Math.ceil((cooldownMs - sinceLastMs) / 60000)}min`,
      };
    }

    // ── Apply acceleration ─────────────────────────────────────────────────
    const newBudget = Math.min(BUDGET_CAP_INR, currentBudget * targetPhase.multiplier);
    const newState: AccelerationState = {
      campaignId,
      phase:              targetPhase.phase,
      multiplier:         targetPhase.multiplier,
      consecutiveWins,
      lastAccelerationAt: new Date(),
    };

    await this.saveState(newState);

    this.logger.log(
      `[Acceleration] campaign=${campaignId} ` +
      `${state.phase}→${targetPhase.phase} ` +
      `budget=${currentBudget.toFixed(0)}→${newBudget.toFixed(0)} ` +
      `×${targetPhase.multiplier} wins=${consecutiveWins}`,
    );

    return {
      campaignId,
      newBudget,
      oldBudget:  currentBudget,
      multiplier: targetPhase.multiplier,
      phase:      targetPhase.phase,
      applied:    true,
      reason:
        `Accelerated to ${targetPhase.phase}: ` +
        `${consecutiveWins} consecutive wins, ×${targetPhase.multiplier}`,
    };
  }

  /**
   * Force-reset a campaign's acceleration state (called on loss events from kernel).
   */
  async onLoss(campaignId: string): Promise<void> {
    await this.resetState(campaignId);
    this.logger.log(`[Acceleration] reset on loss: campaign=${campaignId}`);
  }

  /**
   * Get current acceleration state for a campaign (for dashboard / audit).
   */
  async getState(campaignId: string): Promise<AccelerationState> {
    return this.getOrLoadState(campaignId);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private resolvePhase(consecutiveWins: number): { phase: AccelerationPhase; multiplier: number } {
    for (const entry of PHASE_MAP) {
      if (consecutiveWins >= entry.wins) {
        return { phase: entry.phase, multiplier: entry.multiplier };
      }
    }
    return { phase: 'BASE', multiplier: 1.0 };
  }

  private async getOrLoadState(campaignId: string): Promise<AccelerationState> {
    if (this.stateCache.has(campaignId)) return this.stateCache.get(campaignId)!;

    try {
      const { rows } = await this.pool.query<any>(
        `SELECT phase, multiplier, consecutive_wins, last_acceleration_at
         FROM pe_acceleration_state
         WHERE campaign_id = $1`,
        [campaignId],
      );
      if (rows.length > 0) {
        const s: AccelerationState = {
          campaignId,
          phase:              rows[0].phase as AccelerationPhase,
          multiplier:         Number(rows[0].multiplier),
          consecutiveWins:    Number(rows[0].consecutive_wins),
          lastAccelerationAt: new Date(rows[0].last_acceleration_at),
        };
        this.stateCache.set(campaignId, s);
        return s;
      }
    } catch { /* cold start */ }

    const defaultState: AccelerationState = {
      campaignId,
      phase:              'BASE',
      multiplier:         1.0,
      consecutiveWins:    0,
      lastAccelerationAt: new Date(0), // epoch → cooldown always expired
    };
    this.stateCache.set(campaignId, defaultState);
    return defaultState;
  }

  private async saveState(state: AccelerationState): Promise<void> {
    this.stateCache.set(state.campaignId, state);
    await this.pool.query(
      `INSERT INTO pe_acceleration_state
         (campaign_id, phase, multiplier, consecutive_wins, last_acceleration_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (campaign_id) DO UPDATE SET
         phase = EXCLUDED.phase,
         multiplier = EXCLUDED.multiplier,
         consecutive_wins = EXCLUDED.consecutive_wins,
         last_acceleration_at = EXCLUDED.last_acceleration_at,
         updated_at = NOW()`,
      [state.campaignId, state.phase, state.multiplier, state.consecutiveWins, state.lastAccelerationAt],
    ).catch(e => this.logger.warn(`Acceleration state save failed: ${e.message}`));
  }

  private async resetState(campaignId: string): Promise<void> {
    const reset: AccelerationState = {
      campaignId,
      phase:              'BASE',
      multiplier:         1.0,
      consecutiveWins:    0,
      lastAccelerationAt: new Date(),
    };
    await this.saveState(reset);
  }
}
