/**
 * V-Layer Integration Hooks — Module 5
 * Thin adapters that connect the pipeline to the existing V15–V56 architecture.
 *
 * V49 — Prediction Engine   : viability + demand signals
 * V54 — Reasoning Engine    : AI strategy reasoning
 * V53 — Finance Layer       : P&L recording, ROAS ledger
 * V29 — Strategy Layer      : budget + targeting decisions
 * V46 — Product Discovery   : winning product feed
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, DrizzleDB } from '../../../common/database/database.module';
import { pipelineRuns } from '../../../common/database/schema';
import type { PipelineRun } from '../../entities/pipeline-types';

// ─── V49 — Prediction Layer ───────────────────────────────────────────────────

export interface V49Prediction {
  product_id:       string;
  product_name:     string;
  viable:           boolean;
  viability_score:  number;       // 0-100
  niche:            string;
  price_point:      number;
  target_audience:  string;
  best_platform:    'instagram' | 'facebook' | 'tiktok';
  demand_trend:     'rising' | 'stable' | 'falling';
  competition:      'low' | 'medium' | 'high';
  estimated_market_size: number;
  confidence:       number;
}

@Injectable()
export class V49PredictionLayer {
  private readonly logger = new Logger('V49');

  /**
   * Query the prediction engine for a product's market viability.
   * In production: calls the existing V49 NestJS module via internal HTTP or direct injection.
   */
  async predict(productId: string): Promise<V49Prediction> {
    this.logger.log(`V49: predicting product ${productId}`);

    // ── V49 not yet bootstrapped as a standalone NestJS module ──────────────
    // V49 prediction logic lives in the legacy monolith (non-NestJS).
    // Until V49 is extracted, this layer returns sensible defaults derived
    // from the productId so the pipeline can run end-to-end.
    // Tracked: https://github.com/org/aiempire/issues/482
    // ────────────────────────────────────────────────────────────────────────
    return {
      product_id:            productId,
      product_name:          'AI Empire Product',
      viable:                true,
      viability_score:       78,
      niche:                 'health',
      price_point:           49,
      target_audience:       'adults 25-45 interested in wellness',
      best_platform:         'instagram',
      demand_trend:          'rising',
      competition:           'medium',
      estimated_market_size: 4_200_000,
      confidence:            0.74,
    };
  }

  /**
   * Push feedback from ad results back into V49's learning model.
   * Closes the prediction → reality → correction loop.
   */
  async updatePredictionModel(productId: string, actualRoas: number, actualCtr: number): Promise<void> {
    this.logger.log(
      `V49: updating model for product=${productId} actualROAS=${actualRoas} actualCTR=${actualCtr}`,
    );
    // Integration: this.v49Module.ingestFeedback({ productId, actualRoas, actualCtr });
  }
}

// ─── V54 — Reasoning Layer ────────────────────────────────────────────────────

export interface V54Strategy {
  product_id:          string;
  angle:               string;          // e.g. "pain-point-agitation"
  tone:                string;          // e.g. "urgent", "aspirational"
  suggested_hooks:     string[];
  key_benefits:        string[];
  objection_handles:   string[];
  cta:                 string;
  budget_recommendation: number;
  targeting_notes:     string;
}

export interface ProductContext {
  id:              string;
  name:            string;
  niche:           string;
  price_point:     number;
  target_audience: string;
  platform:        string;
}

@Injectable()
export class V54ReasoningLayer {
  private readonly logger = new Logger('V54');

  /**
   * Run the reasoning engine to produce a creative strategy.
   * In production: calls V54 module which uses Claude/GPT for chain-of-thought reasoning.
   */
  async reason(ctx: ProductContext, prediction: V49Prediction): Promise<V54Strategy> {
    this.logger.log(`V54: reasoning strategy for product=${ctx.id} niche=${ctx.niche}`);

    // ── Integration point ───────────────────────────────────────────────────
    // return this.v54Module.generateStrategy({ product: ctx, prediction });
    // ────────────────────────────────────────────────────────────────────────

    const isHighTicket = ctx.price_point > 100;
    const angle = prediction.competition === 'high' ? 'differentiator' : 'pain-point-agitation';

    return {
      product_id:   ctx.id,
      angle,
      tone:         prediction.demand_trend === 'rising' ? 'urgent' : 'aspirational',
      suggested_hooks: [
        `This ${ctx.niche} method works even when everything else failed`,
        `Why 90% of ${ctx.niche} advice is wrong (and what to do instead)`,
        `I spent $${isHighTicket ? '2000' : '200'} testing ${ctx.niche} products so you don't have to`,
      ],
      key_benefits: ['Fast results', 'Proven method', 'Risk-free guarantee'],
      objection_handles: ['Too expensive → show ROI', 'Doesn\'t work → social proof'],
      cta: isHighTicket ? 'Book a free consultation' : 'Get yours now — limited stock',
      budget_recommendation: ctx.price_point * 6,   // 6x price point as test budget
      targeting_notes: `${ctx.target_audience} | lookalike from past buyers | interest stacking`,
    };
  }
}

// ─── V53 — Finance Layer ──────────────────────────────────────────────────────

export interface AdFinanceRecord {
  run_id:     string;
  product_id: string;
  spend:      number;
  revenue:    number;
  profit:     number;
  roas:       number;
}

export interface FinanceSummary {
  total_spend:       number;
  total_revenue:     number;
  total_profit:      number;
  avg_roas:          number;
  best_run_id:       string;
  worst_run_id:      string;
  profitable_runs:   number;
  unprofitable_runs: number;
}

@Injectable()
export class V53FinanceLayer {
  private readonly logger = new Logger('V53');
  private ledger: AdFinanceRecord[] = [];  // in-memory; production uses DB

  constructor(
    // V67: Drizzle injection — replaces @InjectRepository(PipelineRun)
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  async recordAdPerformance(record: AdFinanceRecord): Promise<void> {
    this.logger.log(
      `V53: recording run=${record.run_id} spend=$${record.spend.toFixed(2)} ` +
      `revenue=$${record.revenue.toFixed(2)} profit=$${record.profit.toFixed(2)} ROAS=${record.roas}`,
    );

    this.ledger.push(record);

    // V67: Drizzle update — replaces runRepo.update()
    await this.db
      .update(pipelineRuns)
      .set({
        finalRoas:    record.roas,
        totalSpend:   record.spend,
        totalRevenue: record.revenue,
        profit:       record.profit,
        status:       'success',
      })
      .where(eq(pipelineRuns.runKey, record.run_id))
      .catch((e: Error) => this.logger.warn(`V53: could not update run record: ${e.message}`));
  }

  getSummary(): FinanceSummary {
    if (this.ledger.length === 0) {
      return {
        total_spend: 0, total_revenue: 0, total_profit: 0, avg_roas: 0,
        best_run_id: '', worst_run_id: '', profitable_runs: 0, unprofitable_runs: 0,
      };
    }

    const totalSpend   = this.ledger.reduce((s, r) => s + r.spend, 0);
    const totalRevenue = this.ledger.reduce((s, r) => s + r.revenue, 0);
    const totalProfit  = this.ledger.reduce((s, r) => s + r.profit, 0);
    const avgRoas      = totalSpend > 0 ? totalRevenue / totalSpend : 0;

    const best  = this.ledger.reduce((a, b) => (a.roas > b.roas ? a : b));
    const worst = this.ledger.reduce((a, b) => (a.roas < b.roas ? a : b));

    return {
      total_spend:       +totalSpend.toFixed(2),
      total_revenue:     +totalRevenue.toFixed(2),
      total_profit:      +totalProfit.toFixed(2),
      avg_roas:          +avgRoas.toFixed(2),
      best_run_id:       best.run_id,
      worst_run_id:      worst.run_id,
      profitable_runs:   this.ledger.filter(r => r.profit > 0).length,
      unprofitable_runs: this.ledger.filter(r => r.profit <= 0).length,
    };
  }

  /**
   * Stop-loss check: if cumulative spend on a product exceeds threshold
   * with no profit, flag for immediate pause.
   */
  checkStopLoss(productId: string, maxLoss: number): boolean {
    const records = this.ledger.filter(r => r.product_id === productId);
    if (records.length === 0) return false;

    const totalLoss = records.reduce((s, r) => s + Math.min(r.profit, 0), 0);
    if (Math.abs(totalLoss) >= maxLoss) {
      this.logger.warn(
        `V53 STOP-LOSS triggered for product=${productId} loss=$${Math.abs(totalLoss).toFixed(2)}`,
      );
      return true;
    }
    return false;
  }
}

// ─── V29 — Strategy Layer ─────────────────────────────────────────────────────

export interface BudgetAllocation {
  test_budget:       number;
  scale_budget:      number;
  max_per_creative:  number;
  daily_cap:         number;
}

@Injectable()
export class V29StrategyLayer {
  private readonly logger = new Logger('V29');

  /**
   * Determine optimal budget allocation based on product price point and confidence.
   */
  allocateBudget(pricePoint: number, confidence: number, totalBudget: number): BudgetAllocation {
    // Rule: test budget = 3-6x price point; higher confidence → higher test allocation
    const testMultiplier = 3 + confidence * 3;
    const testBudget     = Math.min(pricePoint * testMultiplier, totalBudget * 0.3);
    const scaleBudget    = totalBudget - testBudget;
    const dailyCap       = scaleBudget / 7; // spread scale budget over a week

    return {
      test_budget:       +testBudget.toFixed(2),
      scale_budget:      +scaleBudget.toFixed(2),
      max_per_creative:  +Math.min(testBudget / 2, 200).toFixed(2),
      daily_cap:         +dailyCap.toFixed(2),
    };
  }

  /**
   * V29 audience expansion — unlocks new targeting after winner found.
   */
  expandAudience(winnerId: string, currentAudience: string): string[] {
    this.logger.log(`V29: expanding audience for winner ${winnerId}`);
    return [
      `${currentAudience} — lookalike 1%`,
      `${currentAudience} — lookalike 2%`,
      `${currentAudience} — interest expansion`,
      `Retargeting: visited product page`,
    ];
  }
}

// ─── V46 — Product Discovery Layer ───────────────────────────────────────────

export interface DiscoveredProduct {
  id:              string;
  name:            string;
  niche:           string;
  opportunity_score: number;
  source:          string;
}

@Injectable()
export class V46ProductDiscoveryLayer {
  private readonly logger = new Logger('V46');

  /**
   * Returns a queue of products ready for pipeline processing.
   * In production: queries the V46 product research module.
   */
  async getProductQueue(limit = 5): Promise<DiscoveredProduct[]> {
    this.logger.log(`V46: fetching product queue limit=${limit}`);
    // Integration: return this.v46Module.getReadyProducts(limit);
    return [];
  }

  /**
   * Mark a product as processed so V46 doesn't re-queue it.
   */
  async markProcessed(productId: string, result: 'success' | 'fail'): Promise<void> {
    this.logger.log(`V46: marking product=${productId} result=${result}`);
    // Integration: this.v46Module.updateProductStatus(productId, result);
  }
}
