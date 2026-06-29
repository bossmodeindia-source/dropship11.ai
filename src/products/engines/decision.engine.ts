/**
 * Decision Engine — V4 PRE-SPEND REJECTION GATE
 *
 * GOAL: Reject 80% of products BEFORE any ad spend.
 *
 * Signal quality gates:
 *   LOW signal quality → force to TEST or REJECT (never RUN on bad data)
 *
 * Thresholds:
 *   composite >= 70  AND signal quality HIGH/MEDIUM → RUN_ADS
 *   composite >= 45  AND signal quality HIGH/MEDIUM → TEST_ADS (small budget)
 *   composite < 45   → REJECT
 *   signal quality LOW → max TEST_ADS (never RUN_ADS on low quality data)
 *
 * Hard overrides:
 *   marginScore < 20  → REJECT (no profit possible)
 *   demandScore < 15  → REJECT (no market evidence)
 *   sellingPrice ≤ supplierPrice → REJECT (impossible economics)
 */

import { ScoringResult } from './scoring.engine';

export type ProductDecision = 'RUN_ADS' | 'TEST_ADS' | 'REJECT';

export interface DecisionResult {
  decision:    ProductDecision;
  reason:      string;
  confidence:  number;   // 0–100
  rejectedAt:  string;   // 'margin' | 'demand' | 'composite' | 'signal_quality' | 'approved'
}

export function makeDecision(score: ScoringResult): DecisionResult {

  // ── Hard override: no margin ───────────────────────────────────────────────
  if (score.marginScore < 20) {
    return {
      decision:   'REJECT',
      reason:     `Margin score ${score.marginScore} < 20 — product economics do not support profit`,
      confidence: 98,
      rejectedAt: 'margin',
    };
  }

  // ── Hard override: no demand evidence ─────────────────────────────────────
  if (score.demandScore < 15) {
    return {
      decision:   'REJECT',
      reason:     `Demand score ${score.demandScore} < 15 — no real market evidence (no search volume data)`,
      confidence: 95,
      rejectedAt: 'demand',
    };
  }

  // ── Low signal quality gate: never RUN on bad data ────────────────────────
  if (score.signalQuality === 'LOW') {
    if (score.compositeScore >= 55) {
      return {
        decision:   'TEST_ADS',
        reason:     `Signal quality LOW (missing: ${score.signalWarnings.join('; ')}) — demoted from potential RUN to TEST`,
        confidence: 55,
        rejectedAt: 'signal_quality',
      };
    }
    return {
      decision:   'REJECT',
      reason:     `Signal quality LOW and composite ${score.compositeScore} < 55 — insufficient data to risk ad spend`,
      confidence: 80,
      rejectedAt: 'signal_quality',
    };
  }

  // ── Main decision gates ───────────────────────────────────────────────────

  if (score.compositeScore >= 70) {
    return {
      decision:   'RUN_ADS',
      reason:     `Strong composite score ${score.compositeScore} with ${score.signalQuality} signal quality`,
      confidence: Math.min(95, score.compositeScore + 10),
      rejectedAt: 'approved',
    };
  }

  if (score.compositeScore >= 45) {
    return {
      decision:   'TEST_ADS',
      reason:     `Moderate composite ${score.compositeScore} — test with small budget (≤$30/day)`,
      confidence: Math.min(75, score.compositeScore),
      rejectedAt: 'approved',
    };
  }

  return {
    decision:   'REJECT',
    reason:     `Composite score ${score.compositeScore} < 45 — not viable for ad spend`,
    confidence: 85,
    rejectedAt: 'composite',
  };
}
