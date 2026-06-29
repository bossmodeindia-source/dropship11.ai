/**
 * AovService — Phase 4 P4-2: AOV Increase Engine
 *
 * AOV is the fastest lever to ₹1L/day without spending more on ads.
 *
 * Three mechanisms:
 *   1. Bundles       — "Buy 2, Save 15%" — shown on product page
 *   2. Upsells       — post-add-to-cart offer (e.g. premium variant)
 *   3. Cross-sells   — "Customers also bought" shown post-purchase
 *
 * Auto-optimisation:
 *   - System tracks accept_rate per upsell rule
 *   - Rules with accept_rate < 3% are auto-paused after 200 impressions
 *   - Winning rules (accept_rate ≥ 8%) are boosted (shown more prominently)
 *
 * Example impact:
 *   Base product:  ₹999
 *   Bundle offer:  ₹1,799  → AOV +₹800 (+80%)
 *   Upsell accept: 20%     → blended AOV ≈ ₹1,159
 */

import { Injectable, Logger } from '@nestjs/common';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { Inject } from '@nestjs/common';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export interface BundleInput {
  userId:        string;
  brandId?:      string;
  productIds:    string[];
  productTitles: string[];
  prices:        number[];   // individual prices in ₹
}

export interface UpsellInput {
  userId:          string;
  triggerProduct:  string;  // product ID
  upsellProduct:   string;  // product ID
  upsellType:      'post_cart' | 'post_purchase' | 'cross_sell';
  discountPct:     number;
  productTitle:    string;  // for headline generation
}

export interface AovStats {
  avgOrderValueInr:    number;
  bundleRevenueTotal:  number;
  upsellRevenueTotal:  number;
  topBundle:           { name: string; ordersCount: number; revenue: number } | null;
  topUpsell:           { headline: string; acceptRate: number; revenue: number } | null;
  estimatedAovLift:    number;   // % lift from bundles + upsells vs baseline
}

@Injectable()
export class AovService {
  private readonly logger = new Logger(AovService.name);

  // Auto-pause threshold: < 3% accept after 200 impressions
  private static readonly MIN_ACCEPT_RATE = 0.03;
  private static readonly MIN_IMPRESSIONS  = 200;

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly ai: AiOrchestratorService,
  ) {}

  // ── Bundles ────────────────────────────────────────────────────────────────

  /**
   * Auto-generate bundle offers for a product.
   * Creates 3 variants: Buy 2 (15% off), Buy 3 (25% off), Premium Pack (custom).
   */
  async createBundles(input: BundleInput): Promise<void> {
    const totalPrice = input.prices.reduce((a, b) => a + b, 0);
    const bundles = [
      { name: 'Buy 2, Save 15%',   qty: 2, discountPct: 15 },
      { name: 'Value Pack – Save 25%', qty: 3, discountPct: 25 },
      { name: '🎁 Gift Bundle',    qty: 2, discountPct: 10 },  // positioned as gift
    ];

    for (const b of bundles) {
      const originalPrice = totalPrice * b.qty;
      const bundlePrice   = originalPrice * (1 - b.discountPct / 100);
      await this.db.$client.query(
        `INSERT INTO product_bundles
           (user_id, brand_id, name, product_ids, bundle_price, original_price, discount_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          input.userId,
          input.brandId ?? null,
          b.name,
          JSON.stringify(input.productIds),
          Math.round(bundlePrice),
          Math.round(originalPrice),
          b.discountPct,
        ],
      );
    }

    this.logger.log(`Created ${bundles.length} bundles for user ${input.userId}`);
  }

  /**
   * Create an upsell rule with AI-generated headline.
   */
  async createUpsellRule(input: UpsellInput): Promise<void> {
    const headline = await this.generateUpsellHeadline(input);
    await this.db.$client.query(
      `INSERT INTO upsell_rules
         (user_id, trigger_product, upsell_product, upsell_type, discount_pct, headline)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [input.userId, input.triggerProduct, input.upsellProduct, input.upsellType, input.discountPct, headline],
    );
    this.logger.log(`Upsell rule created: ${input.upsellType} for ${input.triggerProduct} → ${input.upsellProduct}`);
  }

  /**
   * Record an impression and (optionally) an acceptance on a upsell rule.
   * Called by webhook processor when customer is shown the upsell.
   */
  async recordUpsellInteraction(ruleId: string, accepted: boolean, revenueAdded = 0): Promise<void> {
    await this.db.$client.query(
      `UPDATE upsell_rules
          SET impressions   = impressions + 1,
              accepts       = accepts + $2,
              revenue_added = revenue_added + $3
        WHERE id = $1`,
      [ruleId, accepted ? 1 : 0, revenueAdded],
    );

    // Auto-pause low performers
    if (!accepted) {
      await this.autopauseUnderperformers();
    }
  }

  /**
   * Record a bundle order.
   */
  async recordBundleOrder(bundleId: string, revenue: number): Promise<void> {
    await this.db.$client.query(
      `UPDATE product_bundles
          SET orders_count  = orders_count + 1,
              revenue_total = revenue_total + $2,
              updated_at    = NOW()
        WHERE id = $1`,
      [bundleId, revenue],
    );
  }

  /**
   * Get comprehensive AOV stats for a user.
   */
  async getAovStats(userId: string): Promise<AovStats> {
    const [bundleRow, upsellRow, topBundleRow, topUpsellRow] = await Promise.all([
      this.db.$client.query(
        `SELECT COALESCE(SUM(revenue_total), 0) AS total FROM product_bundles WHERE user_id = $1 AND is_active = TRUE`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT COALESCE(SUM(revenue_added), 0) AS total FROM upsell_rules WHERE user_id = $1 AND is_active = TRUE`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT name, orders_count, revenue_total FROM product_bundles
          WHERE user_id = $1 AND is_active = TRUE ORDER BY revenue_total DESC LIMIT 1`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT headline, impressions, accepts, revenue_added FROM upsell_rules
          WHERE user_id = $1 AND is_active = TRUE AND impressions > 0
          ORDER BY (accepts::float / NULLIF(impressions, 0)) DESC LIMIT 1`,
        [userId],
      ),
    ]);

    const bundleRevenue = parseFloat(bundleRow.rows[0]?.total ?? '0');
    const upsellRevenue = parseFloat(upsellRow.rows[0]?.total ?? '0');

    const topUpsellData = topUpsellRow.rows[0];
    const acceptRate = topUpsellData
      ? (topUpsellData.accepts / Math.max(topUpsellData.impressions, 1))
      : 0;

    return {
      avgOrderValueInr:   0,  // populated by dashboard snapshot
      bundleRevenueTotal: bundleRevenue,
      upsellRevenueTotal: upsellRevenue,
      topBundle: topBundleRow.rows[0]
        ? { name: topBundleRow.rows[0].name, ordersCount: topBundleRow.rows[0].orders_count, revenue: topBundleRow.rows[0].revenue_total }
        : null,
      topUpsell: topUpsellData
        ? { headline: topUpsellData.headline, acceptRate, revenue: parseFloat(topUpsellData.revenue_added) }
        : null,
      estimatedAovLift: 0,  // calculated at dashboard level with order data
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async generateUpsellHeadline(input: UpsellInput): Promise<string> {
    const typeLabel = input.upsellType === 'post_cart' ? 'add-to-cart' : 'post-purchase';
    const prompt = `Write a short, punchy ${typeLabel} upsell headline for an Indian e-commerce customer.
Product being upsold: "${input.productTitle}"
Discount: ${input.discountPct}% off
Max 10 words. Be direct. Create urgency. No quotes in response.`;

    try {
      const text = (await this.ai.resolve({ userId: 'system', operation: 'upsell_headline', context: { prompt } })).content;
      return String(text).trim().replace(/['"]/g, '');
    } catch {
      return input.discountPct > 0
        ? `Add ${input.productTitle} now — ${input.discountPct}% off just for you!`
        : `Customers who bought this also love ${input.productTitle}`;
    }
  }

  private async autopauseUnderperformers(): Promise<void> {
    await this.db.$client.query(
      `UPDATE upsell_rules
          SET is_active = FALSE
        WHERE is_active = TRUE
          AND impressions >= $1
          AND (accepts::float / NULLIF(impressions, 0)) < $2`,
      [AovService.MIN_IMPRESSIONS, AovService.MIN_ACCEPT_RATE],
    );
  }
}
