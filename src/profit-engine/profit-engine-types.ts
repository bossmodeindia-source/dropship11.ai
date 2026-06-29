/**
 * ProfitEngine Types — V31 Profit Maximization Layer
 *
 * Shared types for all 8 profit-engine sub-systems:
 *   1. ProfitMaximizerEngine      — ROI gate + risk-adjusted EV
 *   2. GlobalCapitalOptimizer     — cross-store Sharpe allocation
 *   3. WinnerAccelerationEngine   — 1.2x → 1.5x → 2x accelerator
 *   4. LossCutterEngine           — fast kill on negative signals
 *   5. AdvancedBanditEngine       — campaigns × creatives × products
 *   6. StrategyEvolverService     — kill weak, keep elite, generate new
 *   7. GlobalProfitTargetService  — system-wide profit objective tracker
 */

// ── ROI / Scaling types ───────────────────────────────────────────────────────

export interface ROIGateInput {
  campaignId:      string;
  storeId:         string;
  revenue:         number;
  spend:           number;
  currentBudget:   number;
  proposedBudget:  number;
  volatility:      number;
  supplierRisk:    number;    // 0–1
  drawdownPct:     number;    // 0–1
  consecutiveWins: number;
  consecutiveLosses: number;
  ctr:             number;    // click-through rate 0–1
  conversionRate:  number;    // 0–1
  trend:           'RISING' | 'FLAT' | 'DECLINING' | 'VOLATILE';
}

export interface ROIGateResult {
  allowed:           boolean;
  roi:               number;          // (revenue - spend) / spend
  riskScore:         number;          // variance + drawdown + supplier risk
  riskAdjustedEV:    number;          // expected_value / risk_score
  scaleFactor:       number;          // actual multiplier to apply
  blockReason?:      string;
  phase:             'NORMAL' | 'ACCELERATION' | 'HOLD' | 'CUT';
}

// ── Global capital optimizer ──────────────────────────────────────────────────

export interface StoreMetrics {
  storeId:          string;
  roi:              number;
  stability:        number;     // 1 - volatility (0–1)
  growthVelocity:   number;     // ΔProfit / ΔTime normalized
  allocatedCapital: number;
  profit:           number;
  riskScore:        number;
  consecutiveWins:  number;
}

export interface StoreAllocation {
  storeId:          string;
  targetCapital:    number;
  delta:            number;     // target - current (positive = inject, negative = reclaim)
  weight:           number;     // Sharpe weight used
  reason:           string;
}

export interface GlobalAllocationPlan {
  allocations:      StoreAllocation[];
  totalCapital:     number;
  reservedCapital:  number;
  computedAt:       Date;
  objective:        number;     // total expected profit from this allocation
}

// ── Winner acceleration ───────────────────────────────────────────────────────

export type AccelerationPhase = 'BASE' | 'WARM' | 'HOT' | 'PEAK';

export interface AccelerationState {
  campaignId:         string;
  phase:              AccelerationPhase;
  multiplier:         number;   // 1.0 | 1.2 | 1.5 | 2.0
  consecutiveWins:    number;
  lastAccelerationAt: Date;
}

export interface AccelerationDecision {
  campaignId:  string;
  newBudget:   number;
  oldBudget:   number;
  multiplier:  number;
  phase:       AccelerationPhase;
  applied:     boolean;
  reason:      string;
}

// ── Loss cutter ───────────────────────────────────────────────────────────────

export interface LossCutSignal {
  campaignId:        string;
  shouldKill:        boolean;
  urgency:           'IMMEDIATE' | 'NEXT_CYCLE' | 'WATCH';
  reason:            string;
  signals: {
    negativeROI:     boolean;
    poorCTR:         boolean;
    poorConversion:  boolean;
    negativeTrend:   boolean;
    lossStreak:      boolean;
    drawdownBreached: boolean;
  };
  confidenceScore:   number;   // 0–1 confidence that this is a real loser
}

// ── Advanced bandit ───────────────────────────────────────────────────────────

export type BanditArmType = 'CAMPAIGN' | 'CREATIVE' | 'PRODUCT';

export interface BanditArmState {
  armId:      string;
  armType:    BanditArmType;
  parentId?:  string;       // campaignId for creatives/products
  alpha:      number;       // wins + 1
  beta:       number;       // losses + 1
  sample:     number;       // Thompson sample
  budget:     number;       // current budget allocation
  roi:        number;
}

export interface MultiArmAllocation {
  armId:       string;
  armType:     BanditArmType;
  budget:      number;
  pct:         number;
  isExplore:   boolean;
  sample:      number;
}

export interface MultiArmResult {
  allocations:   MultiArmAllocation[];
  exploitArms:   string[];
  exploreArms:   string[];
  totalBudget:   number;
}

// ── Strategy evolver ──────────────────────────────────────────────────────────

export interface StrategyFitnessRecord {
  strategyId:   string;
  name:         string;
  totalProfit:  number;
  roi:          number;
  winRate:      number;
  cycles:       number;
  fitness:      number;    // composite score
  generation:   number;
  status:       'ELITE' | 'TESTING' | 'WEAK' | 'KILLED';
}

export interface EvolutionResult {
  eliteKept:    string[];
  weakKilled:   string[];
  newGenerated: string[];
  cycleId:      string;
}

// ── Global profit target ──────────────────────────────────────────────────────

export interface ProfitSnapshot {
  snapshotAt:         Date;
  totalProfitInr:     number;
  dailyProfitInr:     number;
  weeklyProfitInr:    number;
  monthlyProfitInr:   number;
  activeStores:       number;
  activeCampaigns:    number;
  globalROI:          number;
  targetProgressPct:  number;   // % of monthly target achieved
  projectedMonthly:   number;   // linear projection
  on_track:           boolean;
}

export interface ProfitTargetConfig {
  monthlyTargetInr:   number;
  dailyTargetInr:     number;
  aggressiveThresholdPct: number;   // if below this % of target → go aggressive
  conservativeThresholdPct: number; // if above this % → preserve gains
}
