/**
 * ScenarioSimulatorService — V54
 *
 * Simulates best / worst / average case outcomes for a product BEFORE execution.
 *
 * Inputs:
 *   - V49 predictions   (predicted_roas, confidence, demand)
 *   - V53 financial data (global profit summary)
 *   - V48 historical learning (win rates, global learning insights)
 *
 * Outputs:
 *   ScenarioResult { best_case, worst_case, average_case }
 *
 * READ-ONLY. No execution. No Meta API calls.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PredictionOutput }  from '../predictive/model.service';
import { ProfitBreakdown }   from '../finance/financial-ai.service';

export interface ScenarioCase {
  revenue:        number;
  cost:           number;
  profit:         number;
  roas:           number;
  probability:    number;  // 0–1
}

export interface ScenarioResult {
  best_case:    ScenarioCase;
  worst_case:   ScenarioCase;
  average_case: ScenarioCase;
  expected_profit: number;  // probability-weighted average
  expected_loss:   number;  // max downside (worst case profit if negative)
}

// Scenario multipliers relative to predicted baseline
const BEST_ROAS_MULTIPLIER   = 1.8;
const WORST_ROAS_MULTIPLIER  = 0.3;
const BEST_PROBABILITY       = 0.20;
const WORST_PROBABILITY      = 0.25;
const AVG_PROBABILITY        = 0.55;

@Injectable()
export class ScenarioSimulatorService {
  private readonly logger = new Logger(ScenarioSimulatorService.name);

  simulate(
    prediction:    PredictionOutput,
    globalFinance: ProfitBreakdown,
    testBudget:    number,
    historicalWinRate = 0.35,
  ): ScenarioResult {
    const baseCost       = testBudget;
    const baseRoas       = prediction.roas ?? 1.0;
    const confidence     = Math.min(Math.max(prediction.confidence ?? 0.5, 0.1), 1.0);

    // Win-rate adjustment — higher historical win rate shifts probabilities up
    const winBoost        = historicalWinRate * 0.2;
    const bestProb        = Math.min(BEST_PROBABILITY  + winBoost, 0.40);
    const worstProb       = Math.max(WORST_PROBABILITY - winBoost, 0.10);
    const avgProb         = 1 - bestProb - worstProb;

    const buildCase = (roasMultiplier: number, probability: number): ScenarioCase => {
      const effectiveRoas = baseRoas * roasMultiplier * confidence;
      const revenue       = baseCost * effectiveRoas;
      const profit        = revenue - baseCost;
      return { revenue, cost: baseCost, profit, roas: effectiveRoas, probability };
    };

    const best_case    = buildCase(BEST_ROAS_MULTIPLIER,  bestProb);
    const worst_case   = buildCase(WORST_ROAS_MULTIPLIER, worstProb);
    const average_case = buildCase(1.0,                   avgProb);

    const expected_profit =
      best_case.profit  * bestProb  +
      worst_case.profit * worstProb +
      average_case.profit * avgProb;

    const expected_loss = worst_case.profit < 0 ? Math.abs(worst_case.profit) : 0;

    this.logger.debug(
      `Scenario: best=${best_case.profit.toFixed(0)} ` +
      `worst=${worst_case.profit.toFixed(0)} ` +
      `avg=${average_case.profit.toFixed(0)} ` +
      `EV=${expected_profit.toFixed(0)}`,
    );

    return { best_case, worst_case, average_case, expected_profit, expected_loss };
  }
}
