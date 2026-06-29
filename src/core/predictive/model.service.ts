/**
 * ModelService — V49 Lightweight Weighted Prediction Model
 *
 * No heavy ML libs. Weighted linear model with adjustable weights.
 * Weights are updated by the learning loop via updateWeights().
 *
 * predict(features) → { demand, ctr, conversion, roas, confidence }
 *
 * Confidence = geometric mean of input signal completeness and weight
 * stability. Degrades when amazon or campaign data is absent.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PredictiveFeatureVector } from './feature-builder.service';

export interface ModelWeights {
  // ROAS weights
  roasAmazonScore:   number;
  roasVelocity:      number;
  roasMargin:        number;
  roasObservedRoas:  number;
  roasGlobalWin:     number;
  roasMemory:        number;

  // CTR weights
  ctrAmazonScore:    number;
  ctrRatingScore:    number;
  ctrObservedCtr:    number;
  ctrMemory:         number;

  // Conversion weights
  cvnRoas:           number;
  cvnObservedCvr:    number;
  cvnGlobalWin:      number;

  // Demand weights
  demandVelocity:    number;
  demandAmazonScore: number;
  demandRating:      number;
}

export interface PredictionOutput {
  demand:     number;   // 0–100 normalised demand score
  ctr:        number;   // predicted CTR (0–1)
  conversion: number;   // predicted CVR (0–1)
  roas:       number;   // predicted ROAS (absolute)
  confidence: number;   // 0–1 overall confidence
}

const DEFAULT_WEIGHTS: ModelWeights = {
  roasAmazonScore:   0.20,
  roasVelocity:      0.15,
  roasMargin:        0.20,
  roasObservedRoas:  0.25,
  roasGlobalWin:     0.10,
  roasMemory:        0.10,

  ctrAmazonScore:    0.30,
  ctrRatingScore:    0.25,
  ctrObservedCtr:    0.35,
  ctrMemory:         0.10,

  cvnRoas:           0.30,
  cvnObservedCvr:    0.50,
  cvnGlobalWin:      0.20,

  demandVelocity:    0.45,
  demandAmazonScore: 0.35,
  demandRating:      0.20,
};

const MAX_ROAS_OUTPUT = 8;

@Injectable()
export class ModelService {
  private readonly logger = new Logger(ModelService.name);
  private weights: ModelWeights = { ...DEFAULT_WEIGHTS };

  // ── Public API ─────────────────────────────────────────────────────────────

  predict(f: PredictiveFeatureVector): PredictionOutput {
    const w = this.weights;

    // Predicted ROAS (0–MAX_ROAS_OUTPUT)
    const rawRoas =
      w.roasAmazonScore  * f.amazonScore   +
      w.roasVelocity     * f.velocityScore  +
      w.roasMargin       * f.marginScore    +
      w.roasObservedRoas * f.observedRoas   +
      w.roasGlobalWin    * f.globalWinRate  +
      w.roasMemory       * f.memoryScore;
    const roas = parseFloat((rawRoas * MAX_ROAS_OUTPUT).toFixed(4));

    // Predicted CTR (0–1, capped 0.12)
    const ctr = parseFloat(Math.min(0.12,
      w.ctrAmazonScore * f.amazonScore   +
      w.ctrRatingScore * f.ratingScore   +
      w.ctrObservedCtr * f.observedCtr   +
      w.ctrMemory      * f.memoryScore,
    ).toFixed(4));

    // Predicted conversion (0–1, capped 0.25)
    const conversion = parseFloat(Math.min(0.25,
      w.cvnRoas        * (roas / MAX_ROAS_OUTPUT) +
      w.cvnObservedCvr * f.observedCvr   +
      w.cvnGlobalWin   * f.globalWinRate,
    ).toFixed(4));

    // Demand score (0–100)
    const demand = parseFloat(Math.min(100, Math.max(0,
      (w.demandVelocity    * f.velocityScore +
       w.demandAmazonScore * f.amazonScore   +
       w.demandRating      * f.ratingScore) * 100,
    )).toFixed(2));

    // Confidence: degrades for missing data signals
    let confidence = 0.85;
    if (!f.hasAmazonData)   confidence -= 0.20;
    if (!f.hasCampaignData) confidence -= 0.15;
    confidence = parseFloat(Math.max(0.10, confidence).toFixed(3));

    this.logger.debug(
      `predict product demand=${demand} roas=${roas} ctr=${ctr} cvr=${conversion} conf=${confidence}`,
    );

    return { demand, ctr, conversion, roas, confidence };
  }

  /**
   * Update weights from the learning loop.
   * Partial update — only keys present in patch are changed.
   */
  updateWeights(patch: Partial<ModelWeights>): void {
    this.weights = { ...this.weights, ...patch };
    this.logger.log('ModelService: weights updated via learning loop');
  }

  getWeights(): ModelWeights {
    return { ...this.weights };
  }
}
