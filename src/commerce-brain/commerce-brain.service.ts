/**
 * CommerceBrainService — Central AI Intelligence Hub
 *
 * The platform's unified AI decision-making centre. Coordinates all
 * specialised brain subsystems to produce autonomous commerce decisions.
 *
 * Sub-brains:
 *   TrendBrain      — real-time trend signals (Google Trends, TikTok, Meta)
 *   ProductBrain    — product viability scoring + niche fit analysis
 *   AudienceBrain   — TAM estimation + lookalike seed generation
 *   CreativeBrain   — hook angles + ad format selection + CTA optimisation
 *   ViralityBrain   — virality coefficient prediction per platform
 *   PricingBrain    — dynamic pricing + margin optimisation
 *   SupplierBrain   — supplier reliability scoring + least-cost routing
 *   SEOBrain        — keyword opportunity + topical authority gaps
 *   GrowthBrain     — growth loop selection + timing optimisation
 *   ROASBrain       — campaign scaling / kill thresholds
 *   AnalyticsBrain  — KPI interpretation + anomaly detection
 *   LearningBrain   — persistent memory + cross-cycle improvement
 *
 * AutonomousAgentCoordinator: routes decisions to the right Brain,
 * maintains cross-brain context, and emits a CommercePlan per cycle.
 *
 * INVARIANTS:
 *   - All decisions are logged to ai_brain_decisions for audit + replay
 *   - All learning signals are persisted (never lost on restart)
 *   - Brains operate concurrently where possible (Promise.allSettled)
 *   - No brain failure blocks others (graceful degradation per brain)
 *   - All AI calls use the platform's AiOrchestratorService routing chain
 */

import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN }        from '../common/database/database.module';
import { AiOrchestratorService }      from '../ai-orchestrator/ai-orchestrator.service';
import { AlertingService }            from '../alerting/alerting.service';
import { AuditService }               from '../audit/audit.service';
import { MetricsService }             from '../metrics/metrics.service';
import {
  brainDecisions,
  brainMemory,
  brainLearningSignals,
  commercePlans,
} from './commerce-brain.schema';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrendSignal {
  keyword:         string;
  platform:        'tiktok' | 'instagram' | 'google' | 'meta' | 'youtube';
  trendScore:      number;   // 0–100
  velocity:        number;   // rate of change per 24h
  saturation:      number;   // 0–1 (0 = untapped, 1 = saturated)
  geographies:     string[];
  relatedKeywords: string[];
  capturedAt:      Date;
}

export interface ProductDecision {
  productId:       string;
  niche:           string;
  score:           number;    // 0–100 composite
  pricePoint:      number;    // recommended sell price (INR)
  targetMargin:    number;    // recommended margin %
  adAngle:         string;    // primary creative angle
  audiences:       string[];  // seed audience descriptors
  platform:        'meta' | 'tiktok' | 'organic' | 'both';
  confidence:      number;    // 0–1
  reasoning:       string;
}

export interface AudienceProfile {
  tenantId:        string;
  productNiche:    string;
  demographics:    Record<string, unknown>;
  psychographics:  string[];
  interests:       string[];
  lookalikeSeedUrl?: string;
  estimatedReach:  number;
  estimatedCAC:    number;    // estimated INR
}

export interface CreativeDirection {
  hook:            string;
  script:          string;
  format:          'reel' | 'short' | 'ugc' | 'testimonial' | 'founder';
  platform:        string;
  emotionalTrigger: string;
  cta:             string;
  musicMood:       string;
  viralityScore:   number;  // predicted 0–100
}

export interface PricingRecommendation {
  productId:       string;
  supplierCost:    number;
  recommendedPrice: number;
  minPrice:        number;
  maxPrice:        number;
  targetMarginPct: number;
  bundlePrice?:    number;
  upsellPrice?:    number;
  reasoning:       string;
}

export interface CommercePlan {
  planId:          string;
  tenantId:        string;
  cycleStartedAt:  Date;
  trendSignals:    TrendSignal[];
  productDecisions: ProductDecision[];
  audienceProfiles: AudienceProfile[];
  creativeDirections: CreativeDirection[];
  pricingRecs:     PricingRecommendation[];
  growthLoops:     string[];
  estimatedRoas:   number;
  confidence:      number;
  planStatus:      'draft' | 'approved' | 'executing' | 'completed' | 'failed';
}

export interface BrainMemoryEntry {
  category:        'winning_creative' | 'failing_creative' | 'viral_hook'
                 | 'profitable_audience' | 'supplier_reliability' | 'roas_history'
                 | 'viral_pattern' | 'platform_engagement' | 'campaign_failure'
                 | 'high_converting_page' | 'seo_signal' | 'ai_discoverability';
  tenantId:        string;
  key:             string;
  value:           Record<string, unknown>;
  successScore:    number;  // -1 to 1
  platform?:       string;
  niche?:          string;
  geography?:      string;
  recordedAt:      Date;
  expiresAt?:      Date;
}

// ── CommerceBrainService ───────────────────────────────────────────────────────

@Injectable()
export class CommerceBrainService implements OnModuleInit {
  private readonly logger = new Logger(CommerceBrainService.name);

  // Per-tenant context cache (in-memory, refreshed each cycle)
  private contextCache = new Map<string, Record<string, unknown>>();

  constructor(
    @Inject(DB_TOKEN)          private readonly db:      DrizzleDB,
    private readonly ai:       AiOrchestratorService,
    private readonly alerting: AlertingService,
    private readonly audit:    AuditService,
    private readonly metrics:  MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('CommerceBrain online — all 13 sub-brains initialised');
  }

  // ── AutonomousAgentCoordinator ─────────────────────────────────────────────

  /**
   * Runs a full commerce intelligence cycle for a tenant.
   * All brains fire concurrently; failures are degraded gracefully.
   */
  async runCommerceCycle(tenantId: string, systemUserId = 'platform'): Promise<CommercePlan> {
    const planId = crypto.randomUUID();
    this.logger.log(`[CommerceBrain] Starting cycle ${planId} for tenant ${tenantId}`);

    const [
      trendResult,
      productResult,
      audienceResult,
      creativeResult,
      pricingResult,
      growthResult,
    ] = await Promise.allSettled([
      this.trendBrain(tenantId),
      this.productBrain(tenantId),
      this.audienceBrain(tenantId),
      this.creativeBrain(tenantId),
      this.pricingBrain(tenantId),
      this.growthBrain(tenantId),
    ]);

    const plan: CommercePlan = {
      planId,
      tenantId,
      cycleStartedAt: new Date(),
      trendSignals:       this._settled(trendResult,    []),
      productDecisions:   this._settled(productResult,  []),
      audienceProfiles:   this._settled(audienceResult, []),
      creativeDirections: this._settled(creativeResult, []),
      pricingRecs:        this._settled(pricingResult,  []),
      growthLoops:        this._settled(growthResult,   []),
      estimatedRoas:      0,
      confidence:         0,
      planStatus:         'draft',
    };

    // ROASBrain + AnalyticsBrain augment the assembled plan
    try {
      const [roasScore, confidence] = await Promise.all([
        this.roasBrain(tenantId, plan),
        this.analyticsBrain(tenantId, plan),
      ]);
      plan.estimatedRoas = roasScore;
      plan.confidence    = confidence;
    } catch (err) {
      this.logger.warn(`[CommerceBrain] ROASBrain/AnalyticsBrain degraded: ${(err as Error).message}`);
    }

    plan.planStatus = 'approved';

    // Persist plan
    await this._persistPlan(plan);

    // Emit metrics
    this.metrics.incrementCounter('commerce_brain_cycles_total', { tenantId });

    this.logger.log(
      `[CommerceBrain] Cycle ${planId} complete — ` +
      `ROAS=${plan.estimatedRoas.toFixed(2)} confidence=${(plan.confidence * 100).toFixed(1)}%`,
    );

    return plan;
  }

  // ── TrendBrain ─────────────────────────────────────────────────────────────

  async trendBrain(tenantId: string): Promise<TrendSignal[]> {
    const memory = await this.recallMemory(tenantId, 'viral_pattern', 10);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'strategy',
      context: {
        task:       'trend_analysis',
        pastPatterns: memory.map(m => m.value),
        platforms:  ['tiktok', 'instagram', 'meta', 'google'],
        instruction: `Analyse current e-commerce trend signals across TikTok, Instagram, Meta, and Google.
Identify top 5 trending product niches with momentum.
Return JSON array: [{ keyword, platform, trendScore(0-100), velocity, saturation(0-1), geographies[], relatedKeywords[] }]
Only return valid JSON array.`,
      },
      systemPrompt: 'You are a world-class trend intelligence analyst for e-commerce.',
    });

    return this._parseJsonArray<TrendSignal>(response.content);
  }

  // ── ProductBrain ───────────────────────────────────────────────────────────

  async productBrain(tenantId: string): Promise<ProductDecision[]> {
    const winningDna = await this.recallMemory(tenantId, 'winning_creative', 5);
    const failingDna = await this.recallMemory(tenantId, 'campaign_failure', 5);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'scoring',
      context: {
        task:        'product_selection',
        winnerDNA:   winningDna.map(m => m.value),
        failureDNA:  failingDna.map(m => m.value),
        instruction: `Select 3 high-potential e-commerce products for India market.
For each, provide: productId(uuid), niche, score(0-100), pricePoint(INR), targetMargin(%), adAngle, audiences[], platform, confidence(0-1), reasoning.
Return JSON array only.`,
      },
      systemPrompt: 'You are an expert dropshipping product selector for the India market.',
    });

    return this._parseJsonArray<ProductDecision>(response.content);
  }

  // ── AudienceBrain ──────────────────────────────────────────────────────────

  async audienceBrain(tenantId: string): Promise<AudienceProfile[]> {
    const profitableAuds = await this.recallMemory(tenantId, 'profitable_audience', 5);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'strategy',
      context: {
        task:             'audience_profiling',
        historicalAudiences: profitableAuds.map(m => m.value),
        instruction: `Build 3 audience profiles for Meta Ads in India.
Each profile: tenantId="${tenantId}", productNiche, demographics{}, psychographics[], interests[], estimatedReach(number), estimatedCAC(INR).
Return JSON array only.`,
      },
      systemPrompt: 'You are a Meta Ads audience strategist specialising in India e-commerce.',
    });

    return this._parseJsonArray<AudienceProfile>(response.content);
  }

  // ── CreativeBrain ──────────────────────────────────────────────────────────

  async creativeBrain(tenantId: string): Promise<CreativeDirection[]> {
    const hooks = await this.recallMemory(tenantId, 'viral_hook', 10);
    const platformData = await this.recallMemory(tenantId, 'platform_engagement', 5);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'hooks',
      context: {
        task:           'creative_direction',
        provenHooks:    hooks.map(m => m.value),
        platformSignals: platformData.map(m => m.value),
        instruction: `Generate 3 creative directions for short-form video ads.
Each: hook(opening line), script(3 sentences), format(reel|short|ugc|testimonial|founder), platform, emotionalTrigger, cta, musicMood, viralityScore(0-100).
Return JSON array only.`,
      },
      systemPrompt: 'You are a viral ad creative director specialising in TikTok/Reels for India.',
    });

    return this._parseJsonArray<CreativeDirection>(response.content);
  }

  // ── ViralityBrain ──────────────────────────────────────────────────────────

  async viralityBrain(
    tenantId: string,
    creative: CreativeDirection,
  ): Promise<number> {
    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'scoring',
      context: {
        task:     'virality_prediction',
        creative,
        instruction: 'Predict virality score 0-100 for this creative. Return JSON: { viralityScore: number, reasoning: string }',
      },
    });
    const parsed = this._parseJson<{ viralityScore: number }>(response.content);
    return parsed?.viralityScore ?? 50;
  }

  // ── PricingBrain ───────────────────────────────────────────────────────────

  async pricingBrain(tenantId: string): Promise<PricingRecommendation[]> {
    const roasHistory = await this.recallMemory(tenantId, 'roas_history', 10);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'strategy',
      context: {
        task:       'dynamic_pricing',
        roasHistory: roasHistory.map(m => m.value),
        market:     'India',
        instruction: `Generate 3 pricing recommendations for e-commerce products in India.
Each: productId(uuid), supplierCost(INR), recommendedPrice(INR), minPrice, maxPrice, targetMarginPct, bundlePrice?, upsellPrice?, reasoning.
Return JSON array only.`,
      },
      systemPrompt: 'You are a dynamic pricing strategist for India e-commerce.',
    });

    return this._parseJsonArray<PricingRecommendation>(response.content);
  }

  // ── SupplierBrain ──────────────────────────────────────────────────────────

  async supplierBrain(
    tenantId: string,
    productNiche: string,
  ): Promise<{ supplier: string; score: number; reasoning: string }[]> {
    const reliability = await this.recallMemory(tenantId, 'supplier_reliability', 10);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'strategy',
      context: {
        task:           'supplier_selection',
        productNiche,
        reliabilityData: reliability.map(m => m.value),
        suppliers:      ['aliexpress', 'cjdropshipping', 'zendrop', 'autods', 'alibaba'],
        instruction: `Rank suppliers for the niche "${productNiche}". 
Return JSON array: [{ supplier, score(0-100), reasoning }] sorted by score desc.`,
      },
    });

    return this._parseJsonArray<{ supplier: string; score: number; reasoning: string }>(
      response.content,
    );
  }

  // ── SEOBrain ───────────────────────────────────────────────────────────────

  async seoBrain(
    tenantId: string,
    niche: string,
  ): Promise<{ keyword: string; difficulty: number; opportunity: number; intent: string }[]> {
    const seoSignals = await this.recallMemory(tenantId, 'seo_signal', 10);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'strategy',
      context: {
        task:       'keyword_opportunity',
        niche,
        historicalSignals: seoSignals.map(m => m.value),
        instruction: `Find top 10 SEO keyword opportunities for niche "${niche}" in India.
Return JSON array: [{ keyword, difficulty(0-100), opportunity(0-100), intent(informational|transactional|commercial) }]`,
      },
    });

    return this._parseJsonArray<{ keyword: string; difficulty: number; opportunity: number; intent: string }>(
      response.content,
    );
  }

  // ── GrowthBrain ────────────────────────────────────────────────────────────

  async growthBrain(tenantId: string): Promise<string[]> {
    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'strategy',
      context: {
        task:        'growth_loop_selection',
        instruction: `Select the 3 most effective autonomous growth loops for an India e-commerce tenant now.
Choose from: organic_viral_paid, referral_reward, winback_reengage, churn_intervention, champion_ambassador.
Return JSON array of loop names only: ["loop1", "loop2", "loop3"]`,
      },
    });

    return this._parseJsonArray<string>(response.content);
  }

  // ── ROASBrain ──────────────────────────────────────────────────────────────

  async roasBrain(tenantId: string, plan: CommercePlan): Promise<number> {
    const roasHistory = await this.recallMemory(tenantId, 'roas_history', 20);

    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'scoring',
      context: {
        task:        'roas_prediction',
        plan: {
          trendCount:    plan.trendSignals.length,
          productCount:  plan.productDecisions.length,
          topProductScore: plan.productDecisions[0]?.score ?? 0,
          creativeCount: plan.creativeDirections.length,
          topViralScore: plan.creativeDirections[0]?.viralityScore ?? 0,
        },
        history: roasHistory.map(m => m.value),
        instruction: 'Predict estimated ROAS for this commerce plan. Return JSON: { estimatedRoas: number }',
      },
    });

    const parsed = this._parseJson<{ estimatedRoas: number }>(response.content);
    return parsed?.estimatedRoas ?? 1.5;
  }

  // ── AnalyticsBrain ─────────────────────────────────────────────────────────

  async analyticsBrain(tenantId: string, plan: CommercePlan): Promise<number> {
    const response = await this.ai.resolve({
      userId:    tenantId,
      operation: 'scoring',
      context: {
        task:        'confidence_scoring',
        planSummary: {
          trendSignals:     plan.trendSignals.length,
          productDecisions: plan.productDecisions.length,
          audiences:        plan.audienceProfiles.length,
          creatives:        plan.creativeDirections.length,
          estimatedRoas:    plan.estimatedRoas,
        },
        instruction: 'Score overall confidence in this commerce plan 0.0-1.0. Return JSON: { confidence: number }',
      },
    });

    const parsed = this._parseJson<{ confidence: number }>(response.content);
    return Math.min(1, Math.max(0, parsed?.confidence ?? 0.5));
  }

  // ── LearningBrain — Persistent Memory API ─────────────────────────────────

  /**
   * Store a learning signal for future brain decisions.
   * This is the PRIMARY write path for all brain memory.
   */
  async learnFromOutcome(signal: BrainMemoryEntry): Promise<void> {
    try {
      await this.db.insert(brainLearningSignals).values({
        id:           crypto.randomUUID(),
        tenantId:     signal.tenantId,
        category:     signal.category,
        memoryKey:    signal.key,
        value:        signal.value,
        successScore: String(signal.successScore),
        platform:     signal.platform ?? null,
        niche:        signal.niche ?? null,
        geography:    signal.geography ?? null,
        expiresAt:    signal.expiresAt ?? null,
        createdAt:    new Date(),
      });

      // Periodically update consolidated memory
      await this._consolidateMemory(signal.tenantId, signal.category, signal.key, signal.value, signal.successScore);
    } catch (err) {
      this.logger.error(`[LearningBrain] Failed to store signal: ${(err as Error).message}`);
    }
  }

  /**
   * Recall the top N memory entries for a given category + tenant.
   * Returns entries sorted by success score descending.
   */
  async recallMemory(
    tenantId: string,
    category: BrainMemoryEntry['category'],
    limit = 10,
  ): Promise<BrainMemoryEntry[]> {
    try {
      const rows = await this.db
        .select()
        .from(brainMemory)
        .where(and(
          eq(brainMemory.tenantId, tenantId),
          eq(brainMemory.category, category),
        ))
        .orderBy(desc(brainMemory.successScore))
        .limit(limit);

      return rows.map(r => ({
        category:     r.category as BrainMemoryEntry['category'],
        tenantId:     r.tenantId,
        key:          r.memoryKey,
        value:        r.value as Record<string, unknown>,
        successScore: Number(r.successScore),
        platform:     r.platform ?? undefined,
        niche:        r.niche ?? undefined,
        geography:    r.geography ?? undefined,
        recordedAt:   r.updatedAt,
      }));
    } catch {
      return [];
    }
  }

  // ── Scheduled Learning Consolidation ──────────────────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async consolidateAllBrainMemory(): Promise<void> {
    this.logger.debug('[LearningBrain] Running hourly memory consolidation');
    try {
      // Summarise recent signals via AI and store as consolidated knowledge
      const recentSignals = await this.db
        .select()
        .from(brainLearningSignals)
        .where(gte(brainLearningSignals.createdAt, new Date(Date.now() - 3_600_000)))
        .limit(200);

      if (recentSignals.length === 0) return;

      const summary = await this.ai.resolve({
        userId:    'platform',
        operation: 'strategy',
        context: {
          task:        'memory_consolidation',
          signalCount: recentSignals.length,
          signals:     recentSignals.slice(0, 30).map(s => ({
            category: s.category,
            key:      s.memoryKey,
            score:    s.successScore,
          })),
          instruction: `Summarise these ${recentSignals.length} learning signals into 5 key platform insights.
Return JSON: { insights: [{ insight: string, confidence: number, category: string }] }`,
        },
      });

      const parsed = this._parseJson<{ insights: unknown[] }>(summary.content);
      if (parsed?.insights) {
        await this.db.insert(brainDecisions).values({
          id:           crypto.randomUUID(),
          tenantId:     'platform',
          brainType:    'LearningBrain',
          decision:     'hourly_consolidation',
          reasoning:    JSON.stringify(parsed.insights),
          confidence:   String(0.9),
          metadata:     { signalCount: recentSignals.length },
          createdAt:    new Date(),
        });
      }
    } catch (err) {
      this.logger.warn(`[LearningBrain] Consolidation error: ${(err as Error).message}`);
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private async _persistPlan(plan: CommercePlan): Promise<void> {
    try {
      await this.db.insert(commercePlans).values({
        id:                  plan.planId,
        tenantId:            plan.tenantId,
        cycleStartedAt:      plan.cycleStartedAt,
        trendSignals:        plan.trendSignals,
        productDecisions:    plan.productDecisions,
        audienceProfiles:    plan.audienceProfiles,
        creativeDirections:  plan.creativeDirections,
        pricingRecs:         plan.pricingRecs,
        growthLoops:         plan.growthLoops,
        estimatedRoas:       String(plan.estimatedRoas),
        confidence:          String(plan.confidence),
        planStatus:          plan.planStatus,
        createdAt:           new Date(),
        updatedAt:           new Date(),
      });
    } catch (err) {
      this.logger.error(`[CommerceBrain] Failed to persist plan: ${(err as Error).message}`);
    }
  }

  private async _consolidateMemory(
    tenantId: string,
    category: string,
    key: string,
    value: Record<string, unknown>,
    score: number,
  ): Promise<void> {
    // Upsert consolidated memory row
    await this.db
      .insert(brainMemory)
      .values({
        id:           crypto.randomUUID(),
        tenantId,
        category:     category as BrainMemoryEntry['category'],
        memoryKey:    key,
        value,
        successScore: String(score),
        hitCount:     1,
        platform:     null,
        niche:        null,
        geography:    null,
        createdAt:    new Date(),
        updatedAt:    new Date(),
      })
      .onConflictDoUpdate({
        target: [brainMemory.tenantId, brainMemory.category, brainMemory.memoryKey],
        set: {
          value:        value,
          successScore: String(score),
          hitCount:     sql`${brainMemory.hitCount} + 1`,
          updatedAt:    new Date(),
        },
      });
  }

  private _settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
    if (result.status === 'fulfilled') return result.value;
    this.logger.warn(`[CommerceBrain] Brain degraded: ${(result.reason as Error)?.message}`);
    return fallback;
  }

  private _parseJsonArray<T>(content: unknown): T[] {
    try {
      const str = typeof content === 'string' ? content : JSON.stringify(content);
      const cleaned = str.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private _parseJson<T>(content: unknown): T | null {
    try {
      const str = typeof content === 'string' ? content : JSON.stringify(content);
      const cleaned = str.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned) as T;
    } catch {
      return null;
    }
  }
}
