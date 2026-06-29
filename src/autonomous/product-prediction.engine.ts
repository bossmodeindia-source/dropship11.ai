/**
 * ProductPredictionEngine — V3 MODULE #2
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 *   Predict whether a new product is a likely winner BEFORE any ad spend,
 *   using similarity scoring against historical winner DNA patterns.
 *
 * SCORING LOGIC
 *   similarity_score   = categoryMatch × 40 + priceMatch × 25 +
 *                        marginScore   × 20 + reviewScore × 15
 *
 *   category_match     = exact (1.0) | related (0.5) | unknown (0.0)
 *   price_match        = 1 − |log(price) − log(dna_midpoint)| / log(10)  clamped 0–1
 *   margin_score       = (retail − supplier) / retail  (gross margin ratio)
 *   review_score       = min(rating / 5, 1)
 *
 * OUTPUT
 *   score 0–100
 *   prediction: HIGH (≥ 65) → direct RUN campaign
 *               MEDIUM (40–64) → TEST campaign
 *               LOW (< 40) → REJECT
 *
 * COLD START
 *   If no DNA exists for the category, falls back to a pure signal score
 *   using margin, review rating and demand signals — never blocks the loop.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger } from '@nestjs/common';
import { WinnerDnaService, WinnerDna } from './winner-dna.service';
import type { RawProduct } from './product-discovery.service';

// ── Public types ──────────────────────────────────────────────────────────────

export type PredictionLabel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ProductPrediction {
  score:         number;         // 0–100
  prediction:    PredictionLabel;
  confidence:    'high' | 'medium' | 'low';
  matchedDna:    WinnerDna | null;
  breakdown: {
    categoryMatch: number;
    priceMatch:    number;
    marginScore:   number;
    reviewScore:   number;
  };
  recommendation: string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

// Phase 2 gates: ≥70 → RUN, 50–69 → TEST (budget capped), <50 → REJECT
const HIGH_THRESHOLD   = 70;
const MEDIUM_THRESHOLD = 50;

// Related category mappings (expand as you learn)
const RELATED_CATEGORIES: Record<string, string[]> = {
  'fitness':     ['health', 'wellness', 'sports', 'yoga'],
  'beauty':      ['skincare', 'haircare', 'cosmetics', 'personal care'],
  'home':        ['kitchen', 'decor', 'garden', 'living'],
  'electronics': ['gadgets', 'tech', 'accessories', 'smart home'],
  'fashion':     ['clothing', 'apparel', 'jewellery', 'accessories'],
  'pets':        ['pet care', 'animal', 'dog', 'cat'],
  'baby':        ['kids', 'children', 'toddler', 'infant'],
};

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ProductPredictionEngine {
  private readonly logger = new Logger(ProductPredictionEngine.name);

  constructor(private readonly dna: WinnerDnaService) {}

  // ── Main predict method ───────────────────────────────────────────────────

  async predict(product: RawProduct): Promise<ProductPrediction> {
    const matchedDna = await this.dna.getDna(product.category, product.estimatedRetail);

    if (!matchedDna || (matchedDna.sampleSize ?? 0) < 2) {
      // Cold start — use signal-only scoring
      return this.coldStartPredict(product);
    }

    return this.dnaPredict(product, matchedDna);
  }

  // ── DNA-based prediction ──────────────────────────────────────────────────

  private dnaPredict(product: RawProduct, dna: WinnerDna): ProductPrediction {
    const breakdown = {
      categoryMatch: this.scoreCategoryMatch(product.category, dna.category ?? "") * 40,
      priceMatch:    this.scorePriceMatch(product.estimatedRetail, dna.priceRangeMin ?? 0, dna.priceRangeMax ?? 0) * 25,
      marginScore:   this.scoreMargin(product.supplierPrice, product.estimatedRetail) * 20,
      reviewScore:   this.scoreReviews(product.reviewRating) * 15,
    };

    const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const score = Math.round(clamp(raw, 0, 100));

    // Boost if we have winning hooks (DNA is rich)
    const hookBoost = dna.winningHookPatterns ?? [].length >= 3 ? 5 : 0;
    const finalScore = Math.min(score + hookBoost, 100);

    const prediction = this.label(finalScore);
    const confidence = (dna.sampleSize ?? 0) >= 10 ? 'high'
                     : (dna.sampleSize ?? 0) >= 4  ? 'medium'
                     :                        'low';

    const recommendation = this.buildRecommendation(prediction, dna, product);

    this.logger.debug(
      `[Prediction] "${product.title}" | score=${finalScore} prediction=${prediction} ` +
      `DNA(n=${(dna.sampleSize ?? 0)} ROAS=${(dna.avgRoas ?? 0).toFixed(2)})`,
    );

    return { score: finalScore, prediction, confidence, matchedDna: dna, breakdown, recommendation };
  }

  // ── Cold start (no DNA) ───────────────────────────────────────────────────

  private coldStartPredict(product: RawProduct): ProductPrediction {
    const marginScore = this.scoreMargin(product.supplierPrice, product.estimatedRetail);
    const reviewScore = this.scoreReviews(product.reviewRating);

    // Penalise if price is outside proven Indian e-com sweet spot (₹299–₹1999)
    const priceBonus = product.estimatedRetail >= 299 && product.estimatedRetail <= 1999 ? 10 : 0;

    const score = Math.round(clamp(marginScore * 50 + reviewScore * 40 + priceBonus, 0, 100));
    const prediction = this.label(score);

    this.logger.debug(
      `[Prediction] COLD-START "${product.title}" | score=${score} (no DNA for category="${product.category}")`,
    );

    return {
      score,
      prediction,
      confidence: 'low',
      matchedDna:  null,
      breakdown: {
        categoryMatch: 0,
        priceMatch:    priceBonus,
        marginScore:   marginScore * 50,
        reviewScore:   reviewScore * 40,
      },
      recommendation: `No DNA for "${product.category}" yet. ${prediction === 'LOW' ? 'Skip.' : 'Run TEST to gather data.'}`,
    };
  }

  // ── Scoring sub-functions ─────────────────────────────────────────────────

  private scoreCategoryMatch(productCat: string, dnaCat: string): number {
    const pc = productCat.toLowerCase();
    const dc = dnaCat.toLowerCase();
    if (pc === dc) return 1.0;
    const related = RELATED_CATEGORIES[dc] ?? [];
    if (related.some(r => pc.includes(r) || r.includes(pc))) return 0.6;
    return 0.0;
  }

  private scorePriceMatch(price: number, dnaMin: number, dnaMax: number): number {
    if (price >= dnaMin && price <= dnaMax) return 1.0;
    const midpoint = (dnaMin + dnaMax) / 2 || 999;
    const logDiff  = Math.abs(Math.log(price + 1) - Math.log(midpoint + 1));
    return clamp(1 - logDiff / Math.log(10), 0, 1);
  }

  private scoreMargin(supplier: number, retail: number): number {
    if (retail <= 0) return 0;
    const margin = (retail - supplier) / retail;
    return clamp(margin, 0, 1);
  }

  private scoreReviews(rating: number): number {
    return clamp(rating / 5, 0, 1);
  }

  // ── Label ─────────────────────────────────────────────────────────────────

  private label(score: number): PredictionLabel {
    if (score >= HIGH_THRESHOLD)   return 'HIGH';
    if (score >= MEDIUM_THRESHOLD) return 'MEDIUM';
    return 'LOW';
  }

  // ── Recommendation builder ────────────────────────────────────────────────

  private buildRecommendation(
    pred:    PredictionLabel,
    dna:     WinnerDna,
    product: RawProduct,
  ): string {
    if (pred === 'HIGH') {
      const hooks = dna.winningHookPatterns ?? [].slice(0, 2).join(' / ');
      return `LAUNCH immediately. Use ${dna.creativeType} style. Winning angle: "${dna.winningAngle}". ` +
             `Best hooks: ${hooks || 'generate fresh UGC hooks'}. ` +
             `Category avg ROAS: ${(dna.avgRoas ?? 0).toFixed(2)}×.`;
    }
    if (pred === 'MEDIUM') {
      return `TEST with ₹1000 budget. Category avg ROAS: ${(dna.avgRoas ?? 0).toFixed(2)}×. ` +
             `Try ${dna.creativeType} creative. Kill at ₹1500 if ROAS < 0.7.`;
    }
    return `REJECT. Category "${product.category}" at ₹${product.estimatedRetail.toFixed(0)} ` +
           `hasn't performed historically. Move to next product.`;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
