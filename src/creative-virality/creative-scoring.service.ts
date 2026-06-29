/**
 * CreativeScoringService
 *
 * Predicts virality, CTR, engagement, and ROAS for generated creatives.
 * Uses heuristic + ML-style scoring based on:
 *  - Hook strength analysis
 *  - Platform-specific engagement patterns
 *  - Niche trend alignment
 *  - Audience psychology signals
 *  - Historical performance data (per tenant)
 *  - Thompson Sampling for A/B variant selection
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';

export interface VideoScoringInput {
  tenantId:  string;
  script:    {
    hook:       string;
    scenes:     Array<{ index: number; imagePrompt: string; videoPrompt: string; durationMs: number; textOverlay?: string }>;
    cta:        string;
    captions:   string;
    hashtags:   string[];
    voiceover:  string;
    musicStyle: string;
  };
  platform:  string;
  style:     string;
  niche:     string;
}

export interface VideoScoringResult {
  viralityScore:   number; // 0-100
  predictedCtr:    number; // 0.00-1.00
  predictedRoas:   number; // e.g. 2.5x
  watchTimeScore:  number; // 0-100
  engagementScore: number; // 0-100
  hookScore:       number; // 0-100
  ctaScore:        number; // 0-100
  signals:         string[];
  recommendation:  'launch' | 'refine' | 'discard';
}

export interface CreativePerformanceRecord {
  hookText:      string;
  platform:      string;
  style:         string;
  niche:         string;
  actualCtr:     number;
  actualRoas:    number;
  viralityScore: number;
  impressions:   number;
}

@Injectable()
export class CreativeScoringService {
  private readonly logger = new Logger(CreativeScoringService.name);

  // Platform baseline CTR benchmarks
  private readonly platformBenchmarks: Record<string, { baseCtr: number; baseRoas: number }> = {
    instagram:       { baseCtr: 0.012, baseRoas: 2.1 },
    tiktok:          { baseCtr: 0.018, baseRoas: 1.8 },
    youtube_shorts:  { baseCtr: 0.008, baseRoas: 2.5 },
    facebook:        { baseCtr: 0.010, baseRoas: 2.3 },
  };

  // Hook pattern signals associated with high performance
  private readonly highPerformanceHooks = [
    /^(i|we|this|stop|watch|you|if you|nobody|secret|how i|warning)/i,
    /\d+x/i,      // "10x", "3x your revenue"
    /\$/i,        // dollar amounts
    /free/i,
    /mistake/i,
    /wrong/i,
    /hack/i,
    /never|always/i,
  ];

  private readonly weakHookPatterns = [
    /^(hi|hello|hey|welcome|introducing)/i,
    /^(we are|our company|our product)/i,
    /^(check out|take a look)/i,
  ];

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
  ) {}

  // ── Main scoring function ─────────────────────────────────────────────────

  async scoreVideo(input: VideoScoringInput): Promise<VideoScoringResult> {
    const signals: string[] = [];

    // ── Hook analysis ─────────────────────────────────────────────────────
    const hookScore = this.scoreHook(input.script.hook, signals);

    // ── CTA analysis ──────────────────────────────────────────────────────
    const ctaScore = this.scoreCta(input.script.cta, signals);

    // ── Scene diversity ───────────────────────────────────────────────────
    const sceneScore = this.scoreScenes(input.script.scenes, input.style, signals);

    // ── Hashtag relevance ─────────────────────────────────────────────────
    const hashtagScore = this.scoreHashtags(input.script.hashtags, input.niche, signals);

    // ── Music alignment ───────────────────────────────────────────────────
    const musicScore = this.scoreMusicStyle(input.script.musicStyle, input.platform, signals);

    // ── Historical performance weight (Thompson Sampling prior) ───────────
    const historicalWeight = await this.getHistoricalPerformanceWeight(
      input.tenantId, input.niche, input.platform, input.style,
    );

    // ── Platform bonus ────────────────────────────────────────────────────
    const platformBonus = this.getPlatformStyleBonus(input.platform, input.style);

    // ── Aggregate scores ──────────────────────────────────────────────────
    const rawScore = (
      hookScore   * 0.30 +
      ctaScore    * 0.15 +
      sceneScore  * 0.20 +
      hashtagScore * 0.10 +
      musicScore  * 0.10 +
      platformBonus * 0.15
    );

    // Apply historical weighting (Bayesian update)
    const viralityScore = Math.min(100, Math.round(rawScore * (0.7 + historicalWeight * 0.3)));

    // ── Predict CTR and ROAS ──────────────────────────────────────────────
    const benchmark = this.platformBenchmarks[input.platform] ?? { baseCtr: 0.010, baseRoas: 2.0 };
    const scoreMultiplier = viralityScore / 50; // 50 = baseline, 100 = 2x benchmark

    const predictedCtr  = Math.min(0.20, benchmark.baseCtr * scoreMultiplier);
    const predictedRoas = Math.min(8.0,  benchmark.baseRoas * (scoreMultiplier * 0.8));

    // ── Watch time heuristic ──────────────────────────────────────────────
    const watchTimeScore = Math.min(100, hookScore * 0.6 + sceneScore * 0.4);

    // ── Engagement score ──────────────────────────────────────────────────
    const engagementScore = Math.min(100, hashtagScore * 0.4 + musicScore * 0.3 + ctaScore * 0.3);

    // ── Recommendation ────────────────────────────────────────────────────
    const recommendation: 'launch' | 'refine' | 'discard' =
      viralityScore >= 65 ? 'launch' :
      viralityScore >= 40 ? 'refine' :
      'discard';

    if (viralityScore >= 80) signals.push('🔥 High virality potential — strong launch candidate');
    if (viralityScore >= 65) signals.push('✅ Above benchmark — recommend launch');
    if (viralityScore < 40)  signals.push('⚠️ Below threshold — refine hook and CTA');

    const result: VideoScoringResult = {
      viralityScore,
      predictedCtr:    Math.round(predictedCtr * 10000) / 10000,
      predictedRoas:   Math.round(predictedRoas * 100)  / 100,
      watchTimeScore:  Math.round(watchTimeScore),
      engagementScore: Math.round(engagementScore),
      hookScore:       Math.round(hookScore),
      ctaScore:        Math.round(ctaScore),
      signals,
      recommendation,
    };

    // Store scoring result for learning loop
    await this.recordScoringEvent(input, result);

    return result;
  }

  // ── Thompson Sampling for A/B variant selection ───────────────────────────

  async selectWinningVariant(
    tenantId: string,
    variantScores: Array<{ variant: string; viralityScore: number; predictedCtr: number }>,
  ): Promise<string> {
    // Get historical performance per variant
    const historicalData = await this.db.query(
      `SELECT ab_variant, AVG(virality_score) AS avg_virality,
              COUNT(*) AS sample_count
       FROM video_pipeline_jobs
       WHERE tenant_id = $1 AND status = 'completed' AND ab_variant IS NOT NULL
       GROUP BY ab_variant`,
      [tenantId],
    );

    const historical = new Map<string, { avgVirality: number; sampleCount: number }>(
      historicalData.rows.map((r: any) => [r.ab_variant as string, {
        avgVirality:  Number(r.avg_virality),
        sampleCount:  Number(r.sample_count),
      }]),
    );

    // Thompson Sampling: sample from Beta distribution per variant
    let bestVariant = variantScores[0]?.variant ?? 'A';
    let bestSample  = -Infinity;

    for (const vs of variantScores) {
      const hist     = historical.get(vs.variant);
      const alpha    = (hist?.avgVirality ?? 50) / 10 + 1;  // successes
      const beta     = 10 - (hist?.avgVirality ?? 50) / 10 + 1; // failures
      const sample   = this.sampleBeta(Math.max(1, alpha), Math.max(1, beta));

      if (sample > bestSample) {
        bestSample  = sample;
        bestVariant = vs.variant;
      }
    }

    return bestVariant;
  }

  // ── Learning loop: record actual performance ──────────────────────────────

  async recordActualPerformance(data: {
    tenantId:      string;
    jobId:         string;
    actualCtr:     number;
    actualRoas:    number;
    impressions:   number;
    conversions:   number;
  }): Promise<void> {
    await this.db.query(
      `UPDATE video_pipeline_jobs
       SET metadata = metadata || $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [
        JSON.stringify({
          actualCtr:    data.actualCtr,
          actualRoas:   data.actualRoas,
          impressions:  data.impressions,
          conversions:  data.conversions,
          performanceUpdatedAt: new Date().toISOString(),
        }),
        data.jobId, data.tenantId,
      ],
    );
  }

  // ── Private scoring methods ───────────────────────────────────────────────

  private scoreHook(hook: string, signals: string[]): number {
    if (!hook || hook.length < 5) return 20;

    let score = 50;

    // Strong hook patterns
    const highMatches = this.highPerformanceHooks.filter(p => p.test(hook)).length;
    score += highMatches * 10;
    if (highMatches > 0) signals.push(`💡 Strong hook pattern detected: "${hook.slice(0, 40)}..."`);

    // Weak hook patterns
    const weakMatches = this.weakHookPatterns.filter(p => p.test(hook)).length;
    score -= weakMatches * 15;
    if (weakMatches > 0) signals.push(`⚠️ Weak hook opener: consider starting with tension`);

    // Length bonus (8-15 words optimal for reels)
    const wordCount = hook.split(/\s+/).length;
    if (wordCount >= 8 && wordCount <= 15) score += 10;
    else if (wordCount > 20) { score -= 10; signals.push('Hook too long — trim to <15 words'); }

    // Question or statement (curiosity gap)
    if (hook.includes('?')) { score += 8; signals.push('✅ Curiosity gap hook (question format)'); }

    // Emotional trigger words
    const emotional = /guarantee|proven|secret|revealed|exposed|banned|deleted|viral/i.test(hook);
    if (emotional) { score += 12; signals.push('✅ Emotional trigger words detected'); }

    return Math.max(10, Math.min(100, score));
  }

  private scoreCta(cta: string, signals: string[]): number {
    if (!cta) return 30;
    let score = 50;

    const urgency = /now|today|limited|last|hurry|before|expires/i.test(cta);
    if (urgency) { score += 15; signals.push('✅ Urgency trigger in CTA'); }

    const action = /click|tap|swipe|shop|get|grab|claim|try|buy|order|link|comment/i.test(cta);
    if (action) { score += 15; signals.push('✅ Clear action verb in CTA'); }

    const benefit = /free|save|off|% off|bonus|gift|discount/i.test(cta);
    if (benefit) { score += 10; signals.push('✅ Benefit-driven CTA'); }

    return Math.max(10, Math.min(100, score));
  }

  private scoreScenes(scenes: any[], style: string, signals: string[]): number {
    if (!scenes || scenes.length === 0) return 20;
    let score = 50;

    // Scene count optimization
    if (scenes.length >= 3 && scenes.length <= 6) { score += 15; }
    else if (scenes.length < 2) { score -= 20; signals.push('⚠️ Too few scenes — add variety'); }
    else if (scenes.length > 8) { score -= 10; signals.push('⚠️ Too many scenes — simplify'); }

    // Prompt quality heuristic
    const avgPromptLength = scenes.reduce((s, sc) => s + (sc.imagePrompt?.length ?? 0), 0) / scenes.length;
    if (avgPromptLength > 50) { score += 10; signals.push('✅ Detailed scene prompts'); }

    // Style-scene alignment
    if (style === 'ugc' && scenes.length <= 4) score += 10;
    if (style === 'cinematic' && scenes.length >= 5) score += 10;

    return Math.max(10, Math.min(100, score));
  }

  private scoreHashtags(hashtags: string[], niche: string, signals: string[]): number {
    if (!hashtags || hashtags.length === 0) return 30;
    let score = 50;

    if (hashtags.length >= 5 && hashtags.length <= 15) { score += 20; }
    else if (hashtags.length < 3) { score -= 15; signals.push('⚠️ Too few hashtags'); }
    else if (hashtags.length > 20) { score -= 10; signals.push('⚠️ Too many hashtags'); }

    // Niche relevance (simple check)
    const nicheWords = niche.toLowerCase().split(/\s+/);
    const relevant = hashtags.filter(h =>
      nicheWords.some(w => h.toLowerCase().includes(w))
    ).length;
    if (relevant > 0) { score += 15; signals.push(`✅ ${relevant} niche-relevant hashtags`); }

    return Math.max(10, Math.min(100, score));
  }

  private scoreMusicStyle(musicStyle: string, platform: string, signals: string[]): number {
    if (!musicStyle) return 40;
    let score = 50;

    // Platform-specific music preferences
    const platformFavorites: Record<string, string[]> = {
      tiktok:         ['trending', 'viral', 'upbeat', 'energetic', 'trap', 'phonk'],
      instagram:      ['upbeat', 'pop', 'emotional', 'inspiring', 'chill'],
      youtube_shorts: ['cinematic', 'energetic', 'motivational'],
      facebook:       ['emotional', 'trust', 'warm', 'inspiring'],
    };

    const favorites = platformFavorites[platform] ?? [];
    const matches   = favorites.filter(f => musicStyle.toLowerCase().includes(f)).length;
    if (matches > 0) { score += 20; signals.push(`✅ Music style aligned with ${platform}`); }

    return Math.max(10, Math.min(100, score));
  }

  private getPlatformStyleBonus(platform: string, style: string): number {
    const bonuses: Record<string, Record<string, number>> = {
      tiktok:         { ugc: 90,  testimonial: 80, minimal: 60, cinematic: 50 },
      instagram:      { ugc: 75,  cinematic: 85,   minimal: 80, testimonial: 70 },
      youtube_shorts: { cinematic: 85, minimal: 75, ugc: 70,    testimonial: 65 },
      facebook:       { testimonial: 85, ugc: 70,  cinematic: 75, minimal: 65 },
    };
    return bonuses[platform]?.[style] ?? 65;
  }

  private async getHistoricalPerformanceWeight(
    tenantId: string,
    niche: string,
    platform: string,
    style: string,
  ): Promise<number> {
    try {
      const result = await this.db.query(
        `SELECT AVG(virality_score) AS avg_score, COUNT(*) AS count
         FROM video_pipeline_jobs
         WHERE tenant_id = $1
           AND status = 'completed'
           AND pipeline_config->>'niche' = $2
           AND pipeline_config->>'platform' = $3
           AND pipeline_config->>'style' = $4
           AND created_at > NOW() - INTERVAL '30 days'`,
        [tenantId, niche, platform, style],
      );

      const row = result.rows[0];
      if (!row || !row.avg_score || Number(row.count) < 3) return 0.5; // neutral prior

      const avgScore = Number(row.avg_score);
      return Math.min(1.0, avgScore / 100);
    } catch {
      return 0.5;
    }
  }

  private async recordScoringEvent(
    input: VideoScoringInput,
    result: VideoScoringResult,
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO user_ai_usage_events (
           tenant_id, connection_id, provider_key, operation,
           success, metadata
         )
         SELECT $1,
           (SELECT id FROM user_ai_provider_connections WHERE tenant_id = $1 LIMIT 1),
           'scoring_engine', 'creative_scoring',
           true, $2
         WHERE EXISTS (SELECT 1 FROM user_ai_provider_connections WHERE tenant_id = $1)`,
        [
          input.tenantId,
          JSON.stringify({
            platform: input.platform, style: input.style, niche: input.niche,
            viralityScore:  result.viralityScore,
            predictedCtr:   result.predictedCtr,
            recommendation: result.recommendation,
          }),
        ],
      );
    } catch { /* best effort */ }
  }

  // ── Beta distribution sampler (Thompson Sampling) ─────────────────────────

  private sampleBeta(alpha: number, beta: number): number {
    // Gamma-based Beta sampling (Marsaglia & Tsang)
    const x = this.sampleGamma(alpha);
    const y = this.sampleGamma(beta);
    return x / (x + y);
  }

  private sampleGamma(shape: number): number {
    if (shape < 1) return this.sampleGamma(1 + shape) * Math.pow(Math.random(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number, v: number;
      do {
        x = this.normalRandom();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  private normalRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
}
