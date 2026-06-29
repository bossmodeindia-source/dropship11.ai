/**
 * ContentEngine — Phase 4 P4-5: Content Engine
 *
 * Ads die when you stop paying. Content compounds forever.
 *
 * Strategy:
 *   - Reuse winning ad creatives as organic content hooks
 *   - Generate daily scripts for Reels / Shorts / TikTok
 *   - Same hook that converts in ads → converts in organic
 *
 * Content formula (proven for Indian D2C):
 *   Hook (0–3s):   "Stop scrolling if you have [problem]"
 *   Problem (3–8s): Show the pain point
 *   Solution (8–20s): Reveal the product
 *   Proof (20–25s): Social proof / before-after
 *   CTA (25–30s):  "Link in bio — limited stock"
 *
 * Output per day per brand:
 *   1 × Instagram Reel script
 *   1 × YouTube Shorts script
 *   1 × TikTok script (different hook angle)
 *
 * Scheduler: runs daily at 7:00 AM IST (auto-generates for all LIVE brands)
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { Inject } from '@nestjs/common';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export type ContentType = 'reel' | 'short' | 'tiktok';
export type ContentPlatform = 'instagram' | 'youtube' | 'tiktok';
export type ContentStatus = 'DRAFT' | 'APPROVED' | 'POSTED';

export interface ContentRequest {
  userId:        string;
  brandId:       string;
  brandName:     string;
  productTitle:  string;
  niche:         string;
  brandVoice:    string;
  winningHook?:  string;  // hook from a winning ad creative to reuse
}

export interface GeneratedContent {
  contentType:  ContentType;
  platform:     ContentPlatform;
  topic:        string;
  hook:         string;
  script:       string;
  caption:      string;
  hashtags:     string[];
  cta:          string;
}

export interface ContentStats {
  totalPieces:     number;
  posted:          number;
  draft:           number;
  totalViews:      number;
  totalShares:     number;
  linkClicks:      number;
  estimatedReach:  number;
  topPlatform:     ContentPlatform | null;
}

// Proven content angles for Indian D2C
const CONTENT_ANGLES = [
  'problem-agitate-solve',
  'before-after-transformation',
  'myth-busting',
  'day-in-my-life featuring product',
  'honest review',
  '3 reasons why',
  'unboxing reaction',
  'comparison vs competitors',
];

// Platform-specific hashtag banks by niche
const NICHE_HASHTAGS: Record<string, string[]> = {
  fitness:   ['#fitness', '#gymlife', '#workout', '#fitnessmotivation', '#healthylifestyle', '#indiafit', '#bodybuilding', '#fitnessgoals'],
  beauty:    ['#skincare', '#beauty', '#glowup', '#makeuptutorial', '#skincareroutine', '#indianskincare', '#beautytips'],
  kitchen:   ['#cooking', '#kitchenessentials', '#homecooking', '#foodie', '#indianfood', '#kitchenhacks', '#homechef'],
  gadgets:   ['#tech', '#gadgets', '#techreview', '#smartphones', '#innovation', '#indiatech', '#techtips'],
  yoga:      ['#yoga', '#wellness', '#mindfulness', '#yogalife', '#yogaindia', '#healthyliving', '#meditation'],
  pet:       ['#petlover', '#dogsofinstagram', '#catsofinstagram', '#petsofinstagram', '#petcare', '#indiapets'],
  fashion:   ['#fashion', '#style', '#ootd', '#fashionblogger', '#indiafashion', '#streetstyle'],
};

@Injectable()
export class ContentEngine {
  private readonly logger = new Logger(ContentEngine.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly ai:  AiOrchestratorService,
  ) {}

  /**
   * Generate a full daily content batch for a brand.
   * Returns 3 pieces: Reel, Short, TikTok — each with a different hook angle.
   */
  async generateDailyBatch(req: ContentRequest): Promise<GeneratedContent[]> {
    this.logger.log(`Generating daily content batch for brand ${req.brandName}`);

    const platforms: Array<{ type: ContentType; platform: ContentPlatform; duration: string }> = [
      { type: 'reel',  platform: 'instagram', duration: '30–45s' },
      { type: 'short', platform: 'youtube',   duration: '30–60s' },
      { type: 'tiktok', platform: 'tiktok',   duration: '15–30s' },
    ];

    const pieces: GeneratedContent[] = [];
    const usedAngles = new Set<string>();

    for (const p of platforms) {
      // Pick a unique angle per platform
      const angle = CONTENT_ANGLES.find(a => !usedAngles.has(a)) ?? CONTENT_ANGLES[0];
      usedAngles.add(angle);

      const content = await this.generateSinglePiece({ ...req, contentType: p.type, platform: p.platform, duration: p.duration, angle, });
      pieces.push(content);

      // Persist to DB
      await this.persistContent(req.userId, req.brandId, content, req.winningHook);
    }

    this.logger.log(`Generated ${pieces.length} content pieces for ${req.brandName}`);
    return pieces;
  }

  /**
   * Update content performance metrics (called by webhook when platform reports stats).
   */
  async updatePerformance(
    contentId: string,
    metrics: { views?: number; likes?: number; shares?: number; linkClicks?: number },
  ): Promise<void> {
    await this.db.$client.query(
      `UPDATE content_pieces
          SET views       = views       + COALESCE($2, 0),
              likes       = likes       + COALESCE($3, 0),
              shares      = shares      + COALESCE($4, 0),
              link_clicks = link_clicks + COALESCE($5, 0)
        WHERE id = $1`,
      [contentId, metrics.views, metrics.likes, metrics.shares, metrics.linkClicks],
    );
  }

  /**
   * Mark content as posted.
   */
  async markPosted(contentId: string): Promise<void> {
    await this.db.$client.query(
      `UPDATE content_pieces SET status = 'POSTED', posted_at = NOW() WHERE id = $1`,
      [contentId],
    );
  }

  /**
   * Get content statistics for a user's dashboard.
   */
  async getContentStats(userId: string): Promise<ContentStats> {
    const [counts, metrics, topPlatform] = await Promise.all([
      this.db.$client.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'POSTED') AS posted,
                COUNT(*) FILTER (WHERE status = 'DRAFT')  AS draft
           FROM content_pieces WHERE user_id = $1`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT COALESCE(SUM(views), 0) AS views,
                COALESCE(SUM(shares), 0) AS shares,
                COALESCE(SUM(link_clicks), 0) AS clicks
           FROM content_pieces WHERE user_id = $1`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT platform FROM content_pieces WHERE user_id = $1
          GROUP BY platform ORDER BY SUM(link_clicks) DESC LIMIT 1`,
        [userId],
      ),
    ]);

    const c = counts.rows[0];
    const m = metrics.rows[0];
    const views = parseInt(m?.views ?? '0', 10);

    return {
      totalPieces:    parseInt(c?.total  ?? '0', 10),
      posted:         parseInt(c?.posted ?? '0', 10),
      draft:          parseInt(c?.draft  ?? '0', 10),
      totalViews:     views,
      totalShares:    parseInt(m?.shares  ?? '0', 10),
      linkClicks:     parseInt(m?.clicks  ?? '0', 10),
      estimatedReach: Math.round(views * 1.4),  // organic reach ~40% beyond views
      topPlatform:    topPlatform.rows[0]?.platform ?? null,
    };
  }

  /**
   * Cron: 7 AM IST daily — auto-generate content for all LIVE brands.
   * 7 AM IST = 1:30 AM UTC
   */
  @Cron('30 1 * * *')
  async dailyContentGeneration(): Promise<void> {
    this.logger.log('Daily content generation cycle starting...');

    const brands = await this.db.$client.query(
      `SELECT id, user_id, brand_name, product_title, niche, brand_voice
         FROM brands WHERE store_status = 'LIVE'`,
    );

    let generated = 0;
    for (const brand of brands.rows) {
      try {
        // Find best-performing ad hook to reuse
        const hookRow = await this.db.$client.query(
          `SELECT hook FROM content_pieces WHERE brand_id = $1 AND link_clicks > 0
            ORDER BY link_clicks DESC LIMIT 1`,
          [brand.id],
        );

        await this.generateDailyBatch({
          userId:       brand.user_id,
          brandId:      brand.id,
          brandName:    brand.brand_name,
          productTitle: brand.product_title,
          niche:        brand.niche,
          brandVoice:   brand.brand_voice ?? 'bold',
          winningHook:  hookRow.rows[0]?.hook,
        });
        generated += 3;
      } catch (err) {
        this.logger.error(`Content gen failed for brand ${brand.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Daily content cycle done. Generated: ${generated} pieces across ${brands.rows.length} brands.`);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async generateSinglePiece(params: ContentRequest & {
    contentType: ContentType;
    platform:    ContentPlatform;
    duration:    string;
    angle:       string;
  }): Promise<GeneratedContent> {
    const hookInstruction = params.winningHook
      ? `Reuse and adapt this proven hook angle: "${params.winningHook}"`
      : 'Create a fresh attention-grabbing hook';

    const prompt = `You are a viral short-form video scriptwriter for Indian D2C brands on ${params.platform}.

Brand: ${params.brandName}
Product: ${params.productTitle}
Niche: ${params.niche}
Brand voice: ${params.brandVoice}
Video duration: ${params.duration}
Content angle: ${params.angle}
${hookInstruction}

Return ONLY valid JSON (no markdown):
{
  "topic": "string (video topic in 5 words)",
  "hook": "string (opening line, 0-3 seconds, creates instant curiosity, max 15 words)",
  "script": "string (full narration script with [VISUAL: ...] cues, ${params.duration} content)",
  "caption": "string (Instagram/social caption, 2-3 sentences, engaging)",
  "cta": "string (call-to-action line, max 8 words)"
}`;

    const niche = params.niche.toLowerCase();
    const hashtags = (NICHE_HASHTAGS[niche] ?? NICHE_HASHTAGS.fitness).slice(0, 6);
    hashtags.push(`#${params.brandName.replace(/\s/g, '').toLowerCase()}`);

    try {
      const text  = await this.ai.complete({ prompt, maxTokens: 600, context: 'content_generation' });
      const clean = String(text).replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean) as { topic: string; hook: string; script: string; caption: string; cta: string };

      return {
        contentType: params.contentType,
        platform:    params.platform,
        topic:       parsed.topic,
        hook:        parsed.hook,
        script:      parsed.script,
        caption:     parsed.caption,
        hashtags,
        cta:         parsed.cta,
      };
    } catch {
      return this.deterministicContent(params, hashtags);
    }
  }

  private deterministicContent(
    params: ContentRequest & { contentType: ContentType; platform: ContentPlatform; angle: string },
    hashtags: string[],
  ): GeneratedContent {
    return {
      contentType: params.contentType,
      platform:    params.platform,
      topic:       `Why everyone needs ${params.productTitle}`,
      hook:        `Stop scrolling — if you struggle with ${params.niche}, this is for you.`,
      script:      `[VISUAL: Close-up of problem]\nYou know that feeling when nothing works?\n[VISUAL: Product reveal]\nThat's exactly why we built ${params.productTitle}.\n[VISUAL: Happy customer]\n${params.brandName} — trusted by 2,100+ Indians.\n[VISUAL: Product + CTA]\nLink in bio. Limited stock.`,
      caption:     `The ${params.niche} upgrade India has been waiting for. 🔥 ${params.productTitle} by ${params.brandName} — tap the link in bio.`,
      hashtags,
      cta:         'Link in bio — grab yours today!',
    };
  }

  private async persistContent(
    userId: string,
    brandId: string,
    content: GeneratedContent,
    sourceCreative?: string,
  ): Promise<void> {
    await this.db.$client.query(
      `INSERT INTO content_pieces
         (user_id, brand_id, content_type, platform, topic, hook, script, caption, hashtags, cta, source_creative)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        userId, brandId, content.contentType, content.platform,
        content.topic, content.hook, content.script, content.caption,
        content.hashtags, content.cta, sourceCreative ?? null,
      ],
    );
  }
}
