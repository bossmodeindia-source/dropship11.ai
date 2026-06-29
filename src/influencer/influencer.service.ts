/**
 * InfluencerService — Phase 4 P4-4: Influencer Automation
 *
 * Ads are expensive. Influencers are cheaper + come with built-in trust.
 *
 * Pipeline:
 *   1. FIND     — AI suggests influencer handles for a niche
 *   2. OUTREACH — AI generates personalised DM/email
 *   3. DEAL     — system tracks deal type (affiliate % or free product)
 *   4. TRACK    — unique promo codes per influencer → attribution
 *   5. MEASURE  — sales, revenue, ROI per influencer
 *
 * Deal economics:
 *   Affiliate deal:     10–20% commission on sales (zero risk)
 *   Free product deal:  1 unit cost + 10% commission
 *   Both beat CPM ads at scale for trusted niches.
 *
 * Target: micro-influencers (10K–100K followers) — 3–8% engagement rate
 * vs mega-influencers (1M+) with 0.5–1% engagement.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { Inject } from '@nestjs/common';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export type Platform   = 'instagram' | 'tiktok' | 'youtube';
export type DealType   = 'AFFILIATE' | 'FREE_PRODUCT' | 'PAID' | 'PENDING';
export type ReplyStatus = 'WAITING' | 'REPLIED' | 'AGREED' | 'DECLINED';

export interface InfluencerSuggestion {
  handle:          string;
  platform:        Platform;
  followerRange:   string;   // '10K–50K'
  engagementHint:  string;   // 'High (fitness niche)'
  outreachAngle:   string;   // why they'd be a good fit
}

export interface OutreachMessage {
  influencerId: string;
  handle:       string;
  message:      string;
  dealType:     DealType;
  promoCode:    string;
}

export interface InfluencerStats {
  totalInfluencers:    number;
  activeDeals:         number;
  pendingOutreach:     number;
  totalRevenue:        number;
  totalSales:          number;
  avgRoi:              number;   // (revenue / commission cost) ratio
  topInfluencer:       { handle: string; platform: Platform; revenue: number } | null;
}

@Injectable()
export class InfluencerService {
  private readonly logger = new Logger(InfluencerService.name);

  // Target: micro-influencers
  private static readonly TARGET_FOLLOWER_MIN = 10_000;
  private static readonly TARGET_FOLLOWER_MAX = 500_000;

  // Niche → content angle map for outreach personalisation
  private static readonly NICHE_ANGLES: Record<string, string> = {
    fitness:     'your workout content is exactly what our audience follows',
    beauty:      'your skincare routines show exactly the results we deliver',
    kitchen:     'your cooking videos are perfect for our kitchen essentials',
    gadgets:     'your honest tech reviews are trusted by the exact audience we want',
    pet:         'your pet content reaches owners who genuinely care about quality',
    fashion:     'your styling content matches our brand aesthetic perfectly',
    yoga:        'your wellness journey aligns with our brand values',
    'posture corrector': 'your fitness content reaches health-conscious followers',
  };

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly ai: AiOrchestratorService,
  ) {}

  /**
   * Suggest influencer handles for a given niche + platform.
   * Returns AI-generated realistic suggestions (not real API scraping).
   */
  async suggestInfluencers(
    niche: string,
    platform: Platform,
    count = 5,
  ): Promise<InfluencerSuggestion[]> {
    const prompt = `You are an influencer marketing expert for Indian D2C brands on ${platform}.

Suggest ${count} REALISTIC micro-influencer profiles for this niche: "${niche}"
Target: 10K–500K followers, high engagement, India-focused audience.

Return ONLY valid JSON array (no markdown):
[{
  "handle": "@handle_name",
  "platform": "${platform}",
  "followerRange": "XXK–XXXK",
  "engagementHint": "string (1 sentence about their content quality)",
  "outreachAngle": "string (1 sentence why they fit this niche)"
}]`;

    try {
      const text = await this.ai.complete({ prompt, maxTokens: 500, context: 'influencer_discovery' });
      const clean = String(text).replace(/```json|```/g, '').trim();
      return JSON.parse(clean) as InfluencerSuggestion[];
    } catch {
      return this.deterministicSuggestions(niche, platform, count);
    }
  }

  /**
   * Add an influencer to the pipeline and generate an outreach message.
   */
  async addInfluencer(params: {
    userId:         string;
    brandId?:       string;
    niche:          string;
    platform:       Platform;
    handle:         string;
    followerCount?: number;
    engagementRate?: number;
    contactEmail?:  string;
    dealType:       DealType;
    commissionPct:  number;
    brandName:      string;
    productTitle:   string;
  }): Promise<OutreachMessage> {
    const promoCode = this.generatePromoCode(params.handle, params.brandName);
    const message   = await this.generateOutreach({ ...params, promoCode });

    await this.db.$client.query(
      `INSERT INTO influencers
         (user_id, brand_id, niche, platform, handle, follower_count, engagement_rate,
          contact_email, deal_type, commission_pct, outreach_msg, promo_code, outreach_sent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE)
       ON CONFLICT (user_id, platform, handle) DO UPDATE
         SET outreach_msg = EXCLUDED.outreach_msg, updated_at = NOW()`,
      [
        params.userId, params.brandId ?? null, params.niche, params.platform, params.handle,
        params.followerCount ?? null, params.engagementRate ?? null, params.contactEmail ?? null,
        params.dealType, params.commissionPct, message, promoCode,
      ],
    );

    const row = await this.db.$client.query(`SELECT id FROM influencers WHERE user_id=$1 AND platform=$2 AND handle=$3`, [params.userId, params.platform, params.handle]);

    return {
      influencerId: row.rows[0]?.id ?? '',
      handle:       params.handle,
      message,
      dealType:     params.dealType,
      promoCode,
    };
  }

  /**
   * Mark outreach as sent and update reply status.
   */
  async updateOutreachStatus(
    influencerId: string,
    outreachSent: boolean,
    replyStatus?: ReplyStatus,
  ): Promise<void> {
    await this.db.$client.query(
      `UPDATE influencers
          SET outreach_sent = $2,
              reply_status  = COALESCE($3, reply_status),
              updated_at    = NOW()
        WHERE id = $1`,
      [influencerId, outreachSent, replyStatus ?? null],
    );
  }

  /**
   * Record a sale attributed to an influencer's promo code.
   */
  async recordInfluencerSale(promoCode: string, orderRevenue: number): Promise<void> {
    await this.db.$client.query(
      `UPDATE influencers
          SET total_sales   = total_sales + 1,
              total_revenue = total_revenue + $2,
              updated_at    = NOW()
        WHERE promo_code = $1`,
      [promoCode, orderRevenue],
    );
    this.logger.log(`Influencer sale: promo=${promoCode} revenue=₹${orderRevenue}`);
  }

  /**
   * Get influencer stats for owner dashboard.
   */
  async getInfluencerStats(userId: string): Promise<InfluencerStats> {
    const [summary, top] = await Promise.all([
      this.db.$client.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE reply_status = 'AGREED') AS active,
           COUNT(*) FILTER (WHERE outreach_sent = FALSE)   AS pending,
           COALESCE(SUM(total_revenue), 0) AS revenue,
           COALESCE(SUM(total_sales), 0)   AS sales
         FROM influencers WHERE user_id = $1`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT handle, platform, total_revenue FROM influencers
          WHERE user_id = $1 ORDER BY total_revenue DESC LIMIT 1`,
        [userId],
      ),
    ]);

    const s = summary.rows[0];
    return {
      totalInfluencers: parseInt(s?.total ?? '0', 10),
      activeDeals:      parseInt(s?.active ?? '0', 10),
      pendingOutreach:  parseInt(s?.pending ?? '0', 10),
      totalRevenue:     parseFloat(s?.revenue ?? '0'),
      totalSales:       parseInt(s?.sales ?? '0', 10),
      avgRoi:           0,  // computed when commission cost data is available
      topInfluencer:    top.rows[0]
        ? { handle: top.rows[0].handle, platform: top.rows[0].platform, revenue: parseFloat(top.rows[0].total_revenue) }
        : null,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async generateOutreach(params: {
    handle: string; platform: Platform; niche: string;
    brandName: string; productTitle: string; dealType: DealType;
    commissionPct: number; promoCode: string;
  }): Promise<string> {
    const angle = InfluencerService.NICHE_ANGLES[params.niche.toLowerCase()]
      ?? 'your content aligns perfectly with what our customers love';

    const dealLine = params.dealType === 'AFFILIATE'
      ? `We're offering a ${params.commissionPct}% commission on every sale from your unique code.`
      : params.dealType === 'FREE_PRODUCT'
      ? `We'd love to send you a free ${params.productTitle} + ${params.commissionPct}% commission on your sales.`
      : `We'd love to collaborate with you on a paid partnership.`;

    const prompt = `Write a short, genuine ${params.platform} DM/email outreach to an influencer for an Indian D2C brand.

Influencer: ${params.handle}
Brand: ${params.brandName}
Product: ${params.productTitle}
Why they fit: ${angle}
Deal: ${dealLine}
Promo code: ${params.promoCode}

Keep it under 120 words. Sound human, not corporate. No subject line needed.`;

    try {
      const text = await this.ai.complete({ prompt, maxTokens: 200, context: 'influencer_outreach' });
      return String(text).trim();
    } catch {
      return `Hey ${params.handle}! 👋

I'm from ${params.brandName} — we sell ${params.productTitle} and ${angle}.

${dealLine} Your unique code: ${params.promoCode}

Would love to chat if you're interested! Drop me a message 🙌

Cheers,
${params.brandName} Team`;
    }
  }

  private generatePromoCode(handle: string, brandName: string): string {
    const cleanHandle = handle.replace('@', '').toUpperCase().slice(0, 8);
    const cleanBrand  = brandName.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 4);
    return `${cleanBrand}${cleanHandle}`.slice(0, 12);
  }

  private deterministicSuggestions(niche: string, platform: Platform, count: number): InfluencerSuggestion[] {
    return Array.from({ length: count }, (_, i) => ({
      handle:        `@${niche.split(' ')[0].toLowerCase()}_creator_${i + 1}`,
      platform,
      followerRange: `${(i + 1) * 20}K–${(i + 1) * 50}K`,
      engagementHint: `Active ${niche} content creator with engaged Indian audience`,
      outreachAngle:  `Their ${niche} content is a natural fit for your product`,
    }));
  }
}
