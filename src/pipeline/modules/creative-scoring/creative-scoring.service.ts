/**
 * Creative Scoring AI — V67 Enterprise Certified
 *
 * V67 CRITICAL FIX #2: TypeORM REMOVED — Drizzle ONLY
 *
 * Previously used @InjectRepository(LearningData) from TypeORM.
 * Now uses Drizzle DB injection with typed queries against the canonical schema.
 *
 * All TypeORM imports (@nestjs/typeorm, typeorm) have been REMOVED.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { eq, and, desc }              from 'drizzle-orm';
import { DB_TOKEN, DrizzleDB }        from '../../../common/database/database.module';
import { learningData }               from '../../../common/database/schema';
import type { LearningData }          from '../../entities/pipeline-types';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface ScoringInput {
  product: string;
  niche: string;
  hooks: string[];
  creative_type: 'video' | 'image';
  platform: 'instagram' | 'facebook' | 'tiktok';
  target_audience: string;
}

export interface ScoringOutput {
  predicted_ctr: number;
  predicted_cvr: number;
  predicted_roas: number;
  confidence_score: number;
  hook_scores: HookScore[];
  recommendation: 'launch' | 'revise' | 'reject';
  rejection_reason?: string;
}

export interface HookScore {
  hook: string;
  strength: number;
  predicted_ctr: number;
  predicted_roas: number;
}

// ─── Scoring Constants ────────────────────────────────────────────────────────

const PLATFORM_BASELINES: Record<string, { ctr: number; cvr: number; roas: number }> = {
  instagram: { ctr: 0.021, cvr: 0.028, roas: 1.9 },
  facebook:  { ctr: 0.019, cvr: 0.031, roas: 2.1 },
  tiktok:    { ctr: 0.035, cvr: 0.022, roas: 1.7 },
};

const TYPE_MULTIPLIERS: Record<string, { ctr: number; cvr: number }> = {
  video: { ctr: 1.42, cvr: 1.18 },
  image: { ctr: 1.00, cvr: 1.00 },
};

const HIGH_CTR_TRIGGERS = [
  'secret','revealed','instant','free','now','stop','warning',
  'limited','exclusive','proven','shocking','finally','never',
  'breakthrough','discover','transform','guaranteed',
];

const WEAK_HOOK_SIGNALS = [
  'introducing','check out','learn more','click here','buy now','shop',
];

const NICHE_ROAS_FACTORS: Record<string, number> = {
  health: 1.25, fitness: 1.18, finance: 1.31, beauty: 1.22,
  ecommerce: 1.10, education: 1.15, saas: 1.28, travel: 1.05,
  gaming: 0.98, default: 1.00,
};

const MIN_ROAS_THRESHOLD       = 1.5;
const MIN_CONFIDENCE_TO_LAUNCH = 0.55;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class CreativeScoringService {
  private readonly logger = new Logger(CreativeScoringService.name);

  constructor(
    // V67: Drizzle DB injection — replaces @InjectRepository(LearningData)
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  async scoreCreative(input: ScoringInput): Promise<ScoringOutput> {
    this.logger.log(`Scoring creative for product=${input.product} niche=${input.niche}`);

    const baseline      = PLATFORM_BASELINES[input.platform] ?? PLATFORM_BASELINES.instagram;
    const typeMultiplier = TYPE_MULTIPLIERS[input.creative_type] ?? TYPE_MULTIPLIERS.image;
    const nicheFactor   = NICHE_ROAS_FACTORS[input.niche.toLowerCase()] ?? NICHE_ROAS_FACTORS.default;

    const historicalData  = await this.getHistoricalData(input.niche, input.creative_type);
    const historicalBias  = this.computeHistoricalBias(historicalData);
    const hookScores      = input.hooks.map(hook =>
      this.scoreHook(hook, baseline, typeMultiplier, nicheFactor, historicalBias),
    );

    const best           = hookScores.reduce((a, b) => a.predicted_roas > b.predicted_roas ? a : b);
    const avgHookStrength = hookScores.reduce((s, h) => s + h.strength, 0) / hookScores.length;
    const clarityMultiplier = this.estimateVisualClarity(input);

    const predicted_ctr  = best.predicted_ctr * clarityMultiplier;
    const predicted_cvr  = baseline.cvr * typeMultiplier.cvr * nicheFactor * (1 + historicalBias.cvr_delta);
    const predicted_roas = best.predicted_roas * clarityMultiplier;
    const confidence_score = this.computeConfidence(historicalData.length, avgHookStrength);
    const recommendation = this.makeRecommendation(predicted_roas, confidence_score);

    const output: ScoringOutput = {
      predicted_ctr:    +predicted_ctr.toFixed(4),
      predicted_cvr:    +predicted_cvr.toFixed(4),
      predicted_roas:   +predicted_roas.toFixed(2),
      confidence_score: +confidence_score.toFixed(3),
      hook_scores:      hookScores,
      recommendation,
    };

    if (recommendation === 'reject') {
      output.rejection_reason =
        predicted_roas < MIN_ROAS_THRESHOLD
          ? `Predicted ROAS ${predicted_roas.toFixed(2)} below threshold (${MIN_ROAS_THRESHOLD})`
          : `Confidence ${confidence_score.toFixed(2)} too low to launch`;
    }

    return output;
  }

  async batchScore(
    inputs: ScoringInput[],
    filterRejected = true,
  ): Promise<Array<{ input: ScoringInput; score: ScoringOutput }>> {
    const results = await Promise.all(
      inputs.map(async input => ({ input, score: await this.scoreCreative(input) })),
    );
    const filtered = filterRejected
      ? results.filter(r => r.score.recommendation !== 'reject')
      : results;
    return filtered.sort((a, b) => b.score.predicted_roas - a.score.predicted_roas);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async getHistoricalData(niche: string, creative_type: string): Promise<LearningData[]> {
    try {
      // V67: Drizzle query — replaces learningRepo.find({ where, order, take })
      return await this.db
        .select()
        .from(learningData)
        .where(
          and(
            eq(learningData.niche, niche),
            eq(learningData.creativeType, creative_type),
          ),
        )
        .orderBy(desc(learningData.createdAt))
        .limit(50);
    } catch { return []; }
  }

  private computeHistoricalBias(data: LearningData[]): {
    ctr_delta: number; cvr_delta: number; roas_delta: number;
  } {
    if (!data.length) return { ctr_delta: 0, cvr_delta: 0, roas_delta: 0 };
    const avgCtr  = data.reduce((s, d) => s + d.ctr, 0) / data.length;
    const avgRoas = data.reduce((s, d) => s + d.roas, 0) / data.length;
    return {
      ctr_delta:  (avgCtr  - 0.021) / 0.021,
      cvr_delta:  0,
      roas_delta: (avgRoas - 2.0) / 2.0,
    };
  }

  private scoreHook(
    hook: string,
    baseline: { ctr: number; cvr: number; roas: number },
    typeMultiplier: { ctr: number; cvr: number },
    nicheFactor: number,
    historicalBias: { ctr_delta: number; roas_delta: number },
  ): HookScore {
    const words = hook.toLowerCase().split(/\s+/);
    let strength = 5.0;
    strength += Math.min(words.filter(w => HIGH_CTR_TRIGGERS.some(t => w.includes(t))).length * 1.2, 4.0);
    strength -= Math.min(words.filter(w => WEAK_HOOK_SIGNALS.some(t => w.includes(t))).length * 1.5, 3.0);
    if (words.length < 4) strength -= 1.5;
    else if (words.length > 18) strength -= 1.0;
    else if (words.length >= 6 && words.length <= 12) strength += 0.5;
    if (hook.includes('?')) strength += 0.8;
    if (/\d+/.test(hook)) strength += 0.6;
    strength = Math.max(0, Math.min(10, strength));

    const hookCtrMultiplier  = 0.6 + (strength / 10) * 0.8;
    const hookRoasMultiplier = 0.7 + (strength / 10) * 0.6;

    return {
      hook,
      strength: +strength.toFixed(1),
      predicted_ctr:  +(baseline.ctr * typeMultiplier.ctr * hookCtrMultiplier * (1 + historicalBias.ctr_delta)).toFixed(4),
      predicted_roas: +(baseline.roas * nicheFactor * hookRoasMultiplier * (1 + historicalBias.roas_delta)).toFixed(2),
    };
  }

  private estimateVisualClarity(input: ScoringInput): number {
    let clarity = 1.0;
    if (input.creative_type === 'video') clarity += 0.08;
    if (input.target_audience.length > 20) clarity += 0.04;
    return Math.min(clarity, 1.15);
  }

  private computeConfidence(historicalCount: number, avgHookStrength: number): number {
    return Math.min((Math.min(historicalCount / 30, 1.0) * 0.5) + ((avgHookStrength / 10) * 0.5) + 0.1, 1.0);
  }

  private makeRecommendation(roas: number, confidence: number): 'launch' | 'revise' | 'reject' {
    if (roas < MIN_ROAS_THRESHOLD)             return 'reject';
    if (confidence < MIN_CONFIDENCE_TO_LAUNCH) return 'revise';
    if (roas >= 2.5 && confidence >= 0.70)     return 'launch';
    return 'revise';
  }
}
