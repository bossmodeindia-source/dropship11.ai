/**
 * FeatureBuilderService — V49 Predictive Engine
 *
 * Aggregates inputs from:
 *   - amazon_products    (V46 signals: compositeScore, velocityScore, ratingScore)
 *   - campaign_metrics   (V24: actual CTR, ROAS, conversions)
 *   - ai_memory          (learning patterns: performanceScore per category)
 *   - global_learning_insights (V29: win/fail rate patterns)
 *
 * Returns a normalised feature vector [0..1] for ModelService.
 * SAFETY: READ-ONLY. No Meta API calls. No kernel bypass.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

export interface PredictiveFeatureVector {
  // V46 signals (0–1 normalised)
  amazonScore:    number;   // compositeScore / 100
  velocityScore:  number;   // velocityScore / 100
  ratingScore:    number;   // ratingScore / 100
  marginScore:    number;   // marginScore / 100

  // V24 observed metrics (0–1 normalised)
  observedRoas:   number;   // actual ROAS / MAX_ROAS cap
  observedCtr:    number;   // actual CTR / MAX_CTR cap
  observedCvr:    number;   // conversion rate / MAX_CVR cap

  // V29 learning signals (0–1)
  globalWinRate:  number;   // from global_learning_insights
  memoryScore:    number;   // ai_memory performanceScore avg for category

  // metadata
  category:       string;
  hasAmazonData:  boolean;
  hasCampaignData: boolean;
}

const MAX_ROAS = 10;
const MAX_CTR  = 0.15;
const MAX_CVR  = 0.30;

@Injectable()
export class FeatureBuilderService {
  private readonly logger = new Logger(FeatureBuilderService.name);

  constructor(private readonly pool: Pool) {}

  async build(productId: string): Promise<PredictiveFeatureVector> {
    const [amazonRow, campaignRow, memoryRow, learningRow] = await Promise.all([
      this.fetchAmazonSignals(productId),
      this.fetchCampaignMetrics(productId),
      this.fetchAiMemory(productId),
      this.fetchGlobalLearning(),
    ]);

    return {
      amazonScore:     this.norm(amazonRow?.compositeScore   ?? 0,  0, 100),
      velocityScore:   this.norm(amazonRow?.velocityScore    ?? 0,  0, 100),
      ratingScore:     this.norm(amazonRow?.ratingScore      ?? 0,  0, 100),
      marginScore:     this.norm(amazonRow?.marginScore      ?? 0,  0, 100),
      observedRoas:    this.norm(campaignRow?.avgRoas        ?? 0,  0, MAX_ROAS),
      observedCtr:     this.norm(campaignRow?.avgCtr         ?? 0,  0, MAX_CTR),
      observedCvr:     this.norm(campaignRow?.avgCvr         ?? 0,  0, MAX_CVR),
      globalWinRate:   this.norm(learningRow?.winRate        ?? 0.5, 0, 1),
      memoryScore:     this.norm(memoryRow?.avgPerformance   ?? 0,  0, 1),
      category:        amazonRow?.category ?? 'unknown',
      hasAmazonData:   !!amazonRow,
      hasCampaignData: !!campaignRow,
    };
  }

  // ── Private Queries ───────────────────────────────────────────────────────

  private async fetchAmazonSignals(productId: string) {
    try {
      const { rows } = await this.pool.query<{
        compositeScore: number; velocityScore: number;
        ratingScore: number;   marginScore: number; category: string;
      }>(
        `SELECT
           composite_score  AS "compositeScore",
           velocity_score   AS "velocityScore",
           rating_score     AS "ratingScore",
           margin_score     AS "marginScore",
           category
         FROM amazon_products
         WHERE product_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [productId],
      );
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private async fetchCampaignMetrics(productId: string) {
    try {
      const { rows } = await this.pool.query<{
        avgRoas: number; avgCtr: number; avgCvr: number;
      }>(
        `SELECT
           AVG(cm.roas)  AS "avgRoas",
           AVG(cm.ctr)   AS "avgCtr",
           AVG(CASE WHEN cm.impressions > 0
                    THEN cm.conversions::numeric / NULLIF(cm.clicks, 0)
                    ELSE 0 END) AS "avgCvr"
         FROM campaigns c
         JOIN campaign_metrics cm ON cm.campaign_id = c.id
         WHERE c.product_id = $1`,
        [productId],
      );
      return rows[0]?.avgRoas != null ? rows[0] : null;
    } catch {
      return null;
    }
  }

  private async fetchAiMemory(productId: string) {
    try {
      const { rows } = await this.pool.query<{ avgPerformance: number }>(
        `SELECT AVG(am.performance_score) AS "avgPerformance"
         FROM ai_memory am
         JOIN products p ON p.category = am.category
         WHERE p.id = $1`,
        [productId],
      );
      return rows[0]?.avgPerformance != null ? rows[0] : null;
    } catch {
      return null;
    }
  }

  private async fetchGlobalLearning() {
    try {
      const { rows } = await this.pool.query<{ winRate: number }>(
        `SELECT AVG(
           CASE WHEN insight_type = 'WIN_PATTERN' THEN 1.0
                WHEN insight_type = 'FAIL_PATTERN' THEN 0.0
                ELSE 0.5 END
         ) AS "winRate"
         FROM global_learning_insights
         WHERE created_at > NOW() - INTERVAL '7 days'`,
      );
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private norm(value: number, min: number, max: number): number {
    if (max <= min) return 0;
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
  }
}
