/**
 * Product Scoring Engine — V4 REAL SIGNALS ONLY
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUDIT FIX — REMOVED ALL HARDCODED SIGNALS:
 *   ❌ demand=5000       → real search volume from trend APIs
 *   ❌ competitor=40     → real competitor density from live data
 *   ❌ trendIndex=70     → real trend signal from Google Trends / social
 *
 * SIGNAL VALIDATION:
 *   If signals are missing/zero → product scored conservatively
 *   Never assume demand. Never assume market size.
 *
 * SCORING WEIGHTS:
 *   demand      30%   — real search volume (Google Trends / SerpAPI)
 *   competition 25%   — real competitor count (inverted: fewer = better)
 *   margin      30%   — real (selling - supplier) / selling × 100
 *   trend       15%   — real trend velocity (rising = high, declining = low)
 *
 * DECISION OUTPUT: REJECT / TEST / RUN
 * GOAL: Reject 80% of products BEFORE any ad spend
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface RawProductSignals {
  supplierPrice:          number;
  estimatedSellingPrice:  number;

  /**
   * REAL search volume from Google Trends / SerpAPI / keyword tool.
   * NEVER hardcode. 0 = unknown (will score poorly = conservative).
   */
  demandSearchVolume:     number;

  /**
   * REAL competitor count from marketplace scanning.
   * NEVER hardcode. 0 = unknown (scored as high competition = conservative).
   */
  competitorCount:        number;

  /**
   * Review rating 0–5. Optional — defaults to 3 if not provided.
   */
  reviewRating:           number;

  /**
   * Real trend index 0–100.
   * 0 = declining / unknown, 100 = peak viral trend.
   * Source: Google Trends, TikTok trending, Meta interest growth.
   * NEVER default to 70.
   */
  trendIndex:             number;

  /**
   * Historical conversion rate from winner DNA (if available).
   * If DNA has data for this category/price bracket → use it.
   * Otherwise 0 = no historical data.
   */
  historicalConversionRate?: number;

  /**
   * Whether this niche has winner DNA available.
   * Boosts confidence in score when true.
   */
  hasDnaMatch?:           boolean;
}

export interface ScoringResult {
  demandScore:       number;   // 0–100
  competitionScore:  number;   // 0–100 (higher = less competition = better)
  marginScore:       number;   // 0–100
  trendScore:        number;   // 0–100
  compositeScore:    number;   // 0–100 weighted
  signalQuality:     'HIGH' | 'MEDIUM' | 'LOW'; // data completeness rating
  signalWarnings:    string[];  // list of missing/suspect signals
  trendIndex?: number;
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Score a product based on REAL signals.
 * Always validate signals before scoring.
 * Never return confident scores from missing data.
 */
export function scoreProduct(signals: RawProductSignals): ScoringResult {
  const warnings: string[] = [];

  // ── Signal validation ────────────────────────────────────────────────────

  // Demand: if 0 = truly unknown → penalise (don't assume)
  const demandIsUnknown = signals.demandSearchVolume === 0;
  if (demandIsUnknown) warnings.push('demandSearchVolume=0: no real trend data — scored conservatively');

  // Competition: 0 = unknown → treat as high competition (conservative)
  const compIsUnknown = signals.competitorCount === 0;
  if (compIsUnknown) warnings.push('competitorCount=0: unknown competition — scored conservatively (assumed high)');

  // Trend: 0 = no trend data → use 20 (depressed, not neutral)
  const trendIsUnknown = signals.trendIndex === 0;
  if (trendIsUnknown) warnings.push('trendIndex=0: no trend signal — scored conservatively');

  // Margin: validate prices
  if (signals.supplierPrice <= 0) warnings.push('supplierPrice <= 0: invalid');
  if (signals.estimatedSellingPrice <= signals.supplierPrice) warnings.push('sellingPrice <= supplierPrice: no margin possible');

  // ── Demand score: log scale, 10k = ~90 ───────────────────────────────────
  const rawDemand     = demandIsUnknown ? 0 : signals.demandSearchVolume;
  const demandScore   = demandIsUnknown
    ? 10  // conservative — not 0 (product might sell, we just don't know)
    : clamp((Math.log10(Math.max(rawDemand, 1)) / 4) * 100);

  // ── Competition score: fewer = better, unknown = conservative ────────────
  const competitionScore = compIsUnknown
    ? 20  // assumed competitive — not 0, not 50
    : clamp(100 - (signals.competitorCount / 200) * 100);

  // ── Margin score: real cost data ─────────────────────────────────────────
  const sell   = signals.estimatedSellingPrice;
  const supply = signals.supplierPrice;
  const margin = sell > supply && supply > 0 ? ((sell - supply) / sell) * 100 : 0;
  const marginScore = clamp(margin);

  // ── Trend score: 0 = unknown → 20 (depressed but not zero) ──────────────
  const trendScore = trendIsUnknown ? 20 : clamp(signals.trendIndex);

  // ── DNA boost: historical winner data improves confidence ─────────────────
  const dnaBoost = signals.hasDnaMatch ? 5 : 0;

  // ── Historical conversion boost ───────────────────────────────────────────
  const convBoost = signals.historicalConversionRate
    ? Math.min(signals.historicalConversionRate * 100, 10)
    : 0;

  // ── Composite: weighted sum ───────────────────────────────────────────────
  const raw = (
    demandScore      * 0.30 +
    competitionScore * 0.25 +
    marginScore      * 0.30 +
    trendScore       * 0.15 +
    dnaBoost +
    convBoost
  );
  const compositeScore = clamp(raw);

  // ── Signal quality rating ─────────────────────────────────────────────────
  const missingCount = [demandIsUnknown, compIsUnknown, trendIsUnknown].filter(Boolean).length;
  const signalQuality: ScoringResult['signalQuality'] =
    missingCount === 0 ? 'HIGH' :
    missingCount === 1 ? 'MEDIUM' : 'LOW';

  return {
    demandScore:      parseFloat(demandScore.toFixed(2)),
    competitionScore: parseFloat(competitionScore.toFixed(2)),
    marginScore:      parseFloat(marginScore.toFixed(2)),
    trendScore:       parseFloat(trendScore.toFixed(2)),
    compositeScore:   parseFloat(compositeScore.toFixed(2)),
    signalQuality,
    signalWarnings:   warnings,
  };
}
