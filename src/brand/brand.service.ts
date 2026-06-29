/**
 * BrandService — Phase 4 P4-1: Winner → Brand Transformer
 *
 * Triggered when a campaign meets the brand graduation criteria:
 *   ROAS ≥ 2  AND  stable for 5–7 consecutive days (winner_streaks.streak ≥ 5)
 *
 * What it creates:
 *   - Brand name (AI-generated, niche-appropriate)
 *   - Tagline
 *   - Brand voice & color palette
 *   - Logo generation prompt
 *   - Store structure blueprint (homepage, product page, related products)
 *
 * Higher trust → higher CVR → more sales from same ad spend.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { Inject } from '@nestjs/common';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export interface BrandGraduationInput {
  userId:        string;
  campaignId:    string;
  productTitle:  string;
  niche:         string;
  roas:          number;
  streakDays:    number;
  sellingPrice:  number;
}

export interface BrandIdentity {
  brandName:      string;
  tagline:        string;
  brandVoice:     'bold' | 'friendly' | 'premium' | 'playful';
  primaryColor:   string;
  secondaryColor: string;
  logoPrompt:     string;
  storeBlueprint: StoreBlueprint;
}

export interface StoreBlueprint {
  homepageHook:    string;   // Above-the-fold headline
  homepageStory:   string;   // Brand story paragraph
  productPageHook: string;   // Product page headline
  socialProof:     string;   // Testimonial angle
  relatedProducts: string[]; // 3–5 product ideas for cross-sell
}

export interface BrandRecord {
  id:             string;
  brandName:      string;
  tagline:        string;
  niche:          string;
  storeStatus:    'PENDING' | 'BUILDING' | 'LIVE';
  primaryColor:   string;
  secondaryColor: string;
  createdAt:      Date;
}

@Injectable()
export class BrandService {
  private readonly logger = new Logger(BrandService.name);

  // Graduation thresholds
  private static readonly ROAS_MIN        = 2.0;
  private static readonly STREAK_DAYS_MIN = 5;

  // Voice → color palette map
  private static readonly VOICE_PALETTES: Record<string, { primary: string; secondary: string }> = {
    bold:     { primary: '#E63946', secondary: '#1D3557' },
    friendly: { primary: '#FF9F1C', secondary: '#2EC4B6' },
    premium:  { primary: '#212121', secondary: '#C9A84C' },
    playful:  { primary: '#7B2D8B', secondary: '#F4A261' },
  };

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly ai:  AiOrchestratorService,
  ) {}

  /**
   * Check if a campaign qualifies for brand graduation.
   * Called by OptimizationScheduler on every SCALE decision.
   */
  isEligibleForGraduation(roas: number, streakDays: number): boolean {
    return roas >= BrandService.ROAS_MIN && streakDays >= BrandService.STREAK_DAYS_MIN;
  }

  /**
   * Create a full brand identity from a winning product.
   * Idempotent — safe to call multiple times (returns existing brand if already created).
   */
  async graduateProductToBrand(input: BrandGraduationInput): Promise<BrandRecord> {
    // Idempotency: return if brand already exists for this campaign
    const existing = await this.db.$client.query(
      `SELECT id, brand_name, tagline, niche, store_status, primary_color, secondary_color, created_at
         FROM brands WHERE campaign_id = $1 LIMIT 1`,
      [input.campaignId],
    );
    if (existing.rows.length > 0) {
      this.logger.log(`Brand already exists for campaign ${input.campaignId}: ${existing.rows[0].brandName}`);
      return existing.rows[0];
    }

    this.logger.log(`Graduating product to brand: "${input.productTitle}" (ROAS ${input.roas}, ${input.streakDays}d streak)`);

    // Generate brand identity via AI
    const identity = await this.generateBrandIdentity(input);

    // Persist brand
    const result = await this.db.$client.query(
      `INSERT INTO brands
         (user_id, campaign_id, product_title, brand_name, tagline, niche,
          logo_prompt, primary_color, secondary_color, brand_voice, store_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')
       RETURNING id, brand_name, tagline, niche, store_status, primary_color, secondary_color, created_at`,
      [
        input.userId,
        input.campaignId,
        input.productTitle,
        identity.brandName,
        identity.tagline,
        input.niche,
        identity.logoPrompt,
        identity.primaryColor,
        identity.secondaryColor,
        identity.brandVoice,
      ],
    );

    const brand = result.rows[0];
    this.logger.log(`Brand created: "${brand.brandName}" (${input.niche}) — ${brand.id}`);
    return brand;
  }

  /**
   * Get all brands for a user with performance data.
   */
  async getBrandsWithPerformance(userId: string): Promise<unknown[]> {
    const result = await this.db.$client.query(
      `SELECT * FROM brand_performance WHERE user_id = $1 ORDER BY bundle_revenue_total DESC`,
      [userId],
    );
    return result.rows;
  }

  /**
   * Update brand store status (called by Shopify integration when store is live).
   */
  async updateStoreStatus(
    brandId: string,
    status: 'PENDING' | 'BUILDING' | 'LIVE',
    urls?: { homepageUrl?: string; productPageUrl?: string },
  ): Promise<void> {
    await this.db.$client.query(
      `UPDATE brands
          SET store_status = $2,
              homepage_url = COALESCE($3, homepage_url),
              product_page_url = COALESCE($4, product_page_url),
              updated_at = NOW()
        WHERE id = $1`,
      [brandId, status, urls?.homepageUrl ?? null, urls?.productPageUrl ?? null],
    );
    this.logger.log(`Brand ${brandId} store status → ${status}`);
  }

  // ── Private: AI brand identity generation ─────────────────────────────────

  private async generateBrandIdentity(input: BrandGraduationInput): Promise<BrandIdentity> {
    const prompt = `You are a branding expert for Indian D2C e-commerce brands.
Create a complete brand identity for a dropshipping winner product.

Product: "${input.productTitle}"
Niche: ${input.niche}
Price point: ₹${input.sellingPrice}
Target market: India (Tier 1 + Tier 2 cities)

Return ONLY valid JSON (no markdown, no explanation):
{
  "brandName": "string (2-3 words, catchy, memorable, no generic words like 'shop/store/hub')",
  "tagline": "string (under 8 words, benefit-focused)",
  "brandVoice": "bold|friendly|premium|playful",
  "logoPrompt": "string (DALL-E prompt for minimal modern logo, 20 words max)",
  "homepageHook": "string (headline that creates instant desire, under 12 words)",
  "homepageStory": "string (2-sentence brand story, problem → solution)",
  "productPageHook": "string (product headline with specific benefit, under 10 words)",
  "socialProof": "string (testimonial angle, e.g. '4,200+ happy customers this month')",
  "relatedProducts": ["string x4 (adjacent products in same niche for cross-sell)"]
}`;

    let parsed: Record<string, unknown>;
    try {
      const response = await this.ai.complete({
        prompt,
        maxTokens: 600,
        context: 'brand_generation',
      });
      const text = typeof response === 'string' ? response : JSON.stringify(response);
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      // Deterministic fallback — system keeps running
      parsed = this.deterministicBrandFallback(input);
    }

    const voice = (parsed.brandVoice as string) || 'bold';
    const palette = BrandService.VOICE_PALETTES[voice] ?? BrandService.VOICE_PALETTES.bold;

    return {
      brandName:    String(parsed.brandName    ?? `${input.niche.split(' ')[0]} Co.`),
      tagline:      String(parsed.tagline      ?? 'Better every day.'),
      brandVoice:   voice as BrandIdentity['brandVoice'],
      primaryColor:   palette.primary,
      secondaryColor: palette.secondary,
      logoPrompt:   String(parsed.logoPrompt   ?? 'Minimal geometric logo, clean lines, bold typography'),
      storeBlueprint: {
        homepageHook:    String(parsed.homepageHook    ?? 'Life is better with the right gear.'),
        homepageStory:   String(parsed.homepageStory   ?? 'We source what actually works. No fluff.'),
        productPageHook: String(parsed.productPageHook ?? input.productTitle),
        socialProof:     String(parsed.socialProof     ?? '1,000+ happy customers'),
        relatedProducts: Array.isArray(parsed.relatedProducts)
          ? (parsed.relatedProducts as string[]).slice(0, 5)
          : [],
      },
    };
  }

  private deterministicBrandFallback(input: BrandGraduationInput): Record<string, unknown> {
    const nicheWord = input.niche.split(' ')[0];
    return {
      brandName:      `${nicheWord}Pro`,
      tagline:        'Built to perform.',
      brandVoice:     'bold',
      logoPrompt:     `Minimal modern logo for ${nicheWord} brand, geometric icon, bold sans-serif`,
      homepageHook:   `The ${input.niche} upgrade you've been waiting for.`,
      homepageStory:  `We obsess over ${input.niche} products so you don't have to. Only proven winners make it to our store.`,
      productPageHook: `The best ${input.productTitle} in India.`,
      socialProof:    '2,100+ five-star orders this month',
      relatedProducts: [`${input.niche} bundle`, `${input.niche} accessories`, `premium ${input.niche}`, `${input.niche} kit`],
    };
  }
}
