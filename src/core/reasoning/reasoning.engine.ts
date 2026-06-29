/**
 * ReasoningEngine — V54 AI Brain
 *
 * Simulates decisions BEFORE execution using:
 *   - ScenarioSimulatorService (best/worst/avg case)
 *   - RiskEngine               (risk_score)
 *
 * simulate(product, context) → ReasoningResult:
 *   {
 *     expected_profit,
 *     expected_loss,
 *     risk_score,
 *     confidence,
 *     decision: "EXECUTE" | "HOLD" | "REJECT"
 *   }
 *
 * Decision rules:
 *   REJECT  — risk_score > 75  OR expected_profit < 0
 *   HOLD    — risk_score > 50  OR confidence < 0.4
 *   EXECUTE — otherwise
 *
 * SAFETY:
 *   - READ-ONLY. No direct execution.
 *   - No Meta API calls.
 *   - Kill switch respected by callers (V26, V29, V50 orchestrator).
 *   - All actual execution still routes through RCCSKernel.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ScenarioSimulatorService } from './scenario-simulator.service';
import { RiskEngine, RiskInput }    from './risk.engine';
import { PredictionOutput }         from '../predictive/model.service';
import { FinancialAiService }       from '../finance/financial-ai.service';

export interface ReasoningContext {
  testBudget:        number;
  capitalExposure:   number;  // 0–1
  volatility:        number;  // ROAS stddev
  pastFailures:      number;
  nicheStability:    number;  // 0–1
  historicalWinRate?: number;
}

export interface ReasoningResult {
  expected_profit: number;
  expected_loss:   number;
  risk_score:      number;
  confidence:      number;
  decision:        'EXECUTE' | 'HOLD' | 'REJECT';
  scenario_summary: {
    best_profit:    number;
    worst_profit:   number;
    average_profit: number;
  };
}

// Decision thresholds
const REJECT_RISK_THRESHOLD   = 75;
const HOLD_RISK_THRESHOLD     = 50;
const HOLD_CONFIDENCE_MIN     = 0.40;

@Injectable()
export class ReasoningEngine {
  private readonly logger = new Logger(ReasoningEngine.name);

  constructor(
    private readonly scenarioSimulator: ScenarioSimulatorService,
    private readonly riskEngine:        RiskEngine,
    private readonly financialAi:       FinancialAiService,
  ) {}

  async simulate(
    prediction: PredictionOutput,
    ctx:        ReasoningContext,
  ): Promise<ReasoningResult> {
    // ── 1. Risk score ─────────────────────────────────────────────────────
    const riskInput: RiskInput = {
      volatility:      ctx.volatility,
      capitalExposure: ctx.capitalExposure,
      pastFailures:    ctx.pastFailures,
      nicheStability:  ctx.nicheStability,
    };
    const { risk_score } = this.riskEngine.calculate(riskInput);

    // ── 2. Financial context for scenario baseline ─────────────────────────
    const globalFinance = await this.financialAi
      .computeProfit({ revenue: 0, adsCost: 0, productCost: 0, shipping: 0, fees: 0 })
      .catch(() => ({
        revenue: 0, adsCost: 0, productCost: 0, shipping: 0, fees: 0,
        profit: 0, roas: 0, margin: 0,
      }));

    // ── 3. Scenario simulation ─────────────────────────────────────────────
    const scenarios = this.scenarioSimulator.simulate(
      prediction,
      globalFinance,
      ctx.testBudget,
      ctx.historicalWinRate ?? 0.35,
    );

    const confidence = prediction.confidence ?? 0.5;

    // ── 4. Decision logic ──────────────────────────────────────────────────
    let decision: ReasoningResult['decision'];

    if (risk_score > REJECT_RISK_THRESHOLD || scenarios.expected_profit < 0) {
      decision = 'REJECT';
    } else if (risk_score > HOLD_RISK_THRESHOLD || confidence < HOLD_CONFIDENCE_MIN) {
      decision = 'HOLD';
    } else {
      decision = 'EXECUTE';
    }

    const result: ReasoningResult = {
      expected_profit: scenarios.expected_profit,
      expected_loss:   scenarios.expected_loss,
      risk_score,
      confidence,
      decision,
      scenario_summary: {
        best_profit:    scenarios.best_case.profit,
        worst_profit:   scenarios.worst_case.profit,
        average_profit: scenarios.average_case.profit,
      },
    };

    this.logger.log(
      `ReasoningEngine: roas=${prediction.roas?.toFixed(2)} ` +
      `risk=${risk_score} conf=${confidence.toFixed(2)} ` +
      `EV=₹${scenarios.expected_profit.toFixed(0)} → ${decision}`,
    );

    return result;
  }
}
