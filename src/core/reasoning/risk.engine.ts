/**
 * RiskEngine — V54
 *
 * Calculates risk_score (0–100) from:
 *   - volatility       : high spread in historical ROAS → high risk
 *   - capital_exposure : % of total capital in one product
 *   - past_failures    : recent consecutive loss count
 *   - niche_stability  : trending vs proven niche signal
 *
 * READ-ONLY. No execution. No Meta API calls.
 * Output feeds ReasoningEngine.simulate().
 */

import { Injectable, Logger } from '@nestjs/common';

export interface RiskInput {
  volatility:       number;  // stddev of recent ROAS samples (0+)
  capitalExposure:  number;  // 0–1 fraction of total capital
  pastFailures:     number;  // consecutive loss count
  nicheStability:   number;  // 0–1 (1 = proven, 0 = untested)
}

export interface RiskOutput {
  risk_score:        number;  // 0–100 (higher = riskier)
  volatility_weight: number;
  exposure_weight:   number;
  failure_weight:    number;
  stability_weight:  number;
}

// Weights must sum to 1
const W_VOLATILITY  = 0.30;
const W_EXPOSURE    = 0.25;
const W_FAILURES    = 0.25;
const W_STABILITY   = 0.20;

const MAX_VOLATILITY   = 3.0;   // ROAS stddev ceiling
const MAX_FAILURES     = 5;     // consecutive losses ceiling
const EXPOSURE_CAP     = 0.50;  // 50% exposure = max score

@Injectable()
export class RiskEngine {
  private readonly logger = new Logger(RiskEngine.name);

  calculate(input: RiskInput): RiskOutput {
    const volatilityScore  = Math.min(input.volatility / MAX_VOLATILITY, 1) * 100;
    const exposureScore    = Math.min(input.capitalExposure / EXPOSURE_CAP, 1) * 100;
    const failureScore     = Math.min(input.pastFailures / MAX_FAILURES, 1) * 100;
    const stabilityScore   = (1 - Math.min(Math.max(input.nicheStability, 0), 1)) * 100;

    const risk_score = Math.round(
      W_VOLATILITY * volatilityScore +
      W_EXPOSURE   * exposureScore   +
      W_FAILURES   * failureScore    +
      W_STABILITY  * stabilityScore,
    );

    this.logger.debug(
      `RiskEngine: vol=${volatilityScore.toFixed(1)} exp=${exposureScore.toFixed(1)} ` +
      `fail=${failureScore.toFixed(1)} stab=${stabilityScore.toFixed(1)} → risk=${risk_score}`,
    );

    return {
      risk_score:        Math.min(Math.max(risk_score, 0), 100),
      volatility_weight: volatilityScore,
      exposure_weight:   exposureScore,
      failure_weight:    failureScore,
      stability_weight:  stabilityScore,
    };
  }
}
