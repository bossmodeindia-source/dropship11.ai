/**
 * ProfitMultipliersService — PHASE 5: AOV + RETENTION + DYNAMIC PRICING ENGINE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TASK 9: Enable Profit Multipliers
 *
 * THREE ENGINES:
 *
 * 1. AOV ENGINE
 *    Bundle: "Buy 2 get 10% off" / "Buy 3 get 15% off"
 *    Upsell: "Add [complement] for ₹X?" at checkout
 *    Cross-sell: "Customers also bought..."
 *    Target: Lift AOV from avg ₹600 → ₹900 (+50%)
 *
 * 2. RETENTION ENGINE
 *    WhatsApp flows: Day 1 / Day 3 / Day 7 post-purchase messages
 *    Email follow-ups: Order confirmation → Review request → Reorder nudge
 *    Repeat buyer discount: 10% off on 2nd order
 *    Target: Repeat purchase rate 15% → 30%
 *
 * 3. DYNAMIC PRICING ENGINE
 *    ROAS > 3.0 → Test price increase (+10%) — more profit per sale
 *    ROAS < 1.5 → Test price decrease (-5%) — more volume
 *    Competitor price monitoring → auto-undercut by ₹50 if needed
 *    Target: Maximize netProfit, not just revenue
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

// ── AOV Engine Types ──────────────────────────────────────────────────────────

export interface BundleOffer {
  productId:      string;
  bundleType:     'buy2_10pct' | 'buy3_15pct' | 'buy5_20pct';
  discountPct:    number;
  bundlePrice:    number;
  estimatedAovLift: number;   // ₹ AOV increase
}

export interface UpsellOffer {
  productId:      string;
  upsellProductId: string;
  upsellTitle:    string;
  upsellPrice:    number;
  discountedPrice: number;
  presentAt:      'checkout' | 'cart' | 'post_purchase';
}

// ── Retention Engine Types ────────────────────────────────────────────────────

export interface RetentionFlow {
  orderId:        string;
  userId:         string;
  customerPhone?: string;
  customerEmail?: string;
  flows:          RetentionStep[];
}

export interface RetentionStep {
  channel:    'whatsapp' | 'email' | 'sms';
  delayHours: number;
  templateId: string;
  message:    string;
  offerCode?: string;
}

// ── Dynamic Pricing Types ─────────────────────────────────────────────────────

export interface PricingRecommendation {
  productId:      string;
  currentPrice:   number;
  recommendedPrice: number;
  delta:          number;
  direction:      'increase' | 'decrease' | 'hold';
  reason:         string;
  estimatedRoasImpact: number;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ProfitMultipliersService {
  private readonly logger = new Logger(ProfitMultipliersService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ════════════════════════════════════════════════════════════════════════════
  // 1. AOV ENGINE
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Generate bundle offers for a product.
   * Activates when: campaign is SCALING (ROAS ≥ 2) to maximise revenue per visitor.
   */
  async generateBundleOffers(
    productId: string,
    sellingPrice: number,
  ): Promise<BundleOffer[]> {
    const offers: BundleOffer[] = [
      {
        productId,
        bundleType:       'buy2_10pct',
        discountPct:      10,
        bundlePrice:      parseFloat((sellingPrice * 2 * 0.90).toFixed(2)),
        estimatedAovLift: parseFloat((sellingPrice * 0.90).toFixed(2)),   // ~90% of 2nd item
      },
      {
        productId,
        bundleType:       'buy3_15pct',
        discountPct:      15,
        bundlePrice:      parseFloat((sellingPrice * 3 * 0.85).toFixed(2)),
        estimatedAovLift: parseFloat((sellingPrice * 1.70).toFixed(2)),   // ~2x lift
      },
    ];

    // Store bundle config for Shopify checkout scripts
    await this.persistBundleConfig(productId, offers).catch(() => null);

    this.logger.log(
      `[AOV] Bundle offers generated | product=${productId} | ` +
      `price=₹${sellingPrice} | offers=${offers.length}`,
    );

    return offers;
  }

  /**
   * Generate upsell offers at checkout.
   * Uses category-based complementary product logic.
   */
  async generateUpsellOffers(
    productId:  string,
    category:   string,
    basePrice:  number,
  ): Promise<UpsellOffer[]> {
    try {
      // Find complementary products in same category priced 30-80% of main product
      const rows = await this.db.execute(sql`
        SELECT id, title, selling_price
        FROM products
        WHERE category = ${category}
          AND id != ${productId}
          AND decision IN ('RUN_ADS', 'TEST_ADS')
          AND selling_price BETWEEN ${basePrice * 0.3} AND ${basePrice * 0.8}
        ORDER BY composite_score DESC
        LIMIT 3
      `) as unknown as Array<{ id: string; title: string; selling_price: string }>;

      return rows.map(row => ({
        productId,
        upsellProductId:  row.id,
        upsellTitle:      row.title,
        upsellPrice:      parseFloat(row.selling_price),
        discountedPrice:  parseFloat((parseFloat(row.selling_price) * 0.85).toFixed(2)),
        presentAt:        'checkout' as const,
      }));
    } catch (err) {
      this.logger.warn(`[AOV] Upsell generation failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. RETENTION ENGINE
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Create post-purchase retention flow.
   * Called by order webhook handler after successful order storage.
   */
  createRetentionFlow(params: {
    orderId:       string;
    userId:        string;
    customerPhone?: string;
    customerEmail?: string;
    productTitle:  string;
    orderTotal:    number;
    campaignId?:   string | null;
  }): RetentionFlow {
    const { orderId, userId, customerPhone, customerEmail, productTitle, orderTotal } = params;

    const steps: any[] = [];

    // WhatsApp flows (if phone available)
    if (customerPhone) {
      // Day 1: Order confirmation + tracking
      steps.push({
        delayHours: 1,
        templateId: 'order_confirmation_v1',
        message: [
          `✅ Your order has been confirmed!`,
          `Product: ${productTitle}`,
          `Amount: ₹${orderTotal}`,
          `We'll send tracking details within 24 hours.`,
          `Questions? Reply to this message! 🙏`,
        ].join('\n'),
      });

      // Day 3: Delivery update + review request
      steps.push({
        delayHours: 72,
        templateId: 'delivery_review_v1',
        message: [
          `📦 Your order is on its way!`,
          `How's everything going? We'd love your feedback.`,
          `Leave a review and get 10% off your next order! 🎁`,
        ].join('\n'),
        offerCode: `REVIEW10_${orderId.slice(0, 8)}`,
      });

      // Day 7: Repeat purchase nudge
      steps.push({
        delayHours: 168,
        templateId: 'reorder_nudge_v1',
        message: [
          `❤️ Hope you're loving your ${productTitle}!`,
          `Ready for more? Use code REPEAT10 for 10% off your next order.`,
          `Valid for 48 hours only! ⏰`,
        ].join('\n'),
        offerCode: 'REPEAT10',
      });
    }

    // Email flows (if email available)
    if (customerEmail) {
      // Immediate: Order confirmation email
      steps.push({
        delayHours: 0,
        templateId: 'order_confirmation_email_v1',
        message:    `Order confirmed: ${productTitle} — ₹${orderTotal}`,
      });

      // Day 5: Review request email
      steps.push({
        delayHours: 120,
        templateId: 'review_request_email_v1',
        message:    `Share your experience with ${productTitle} — get 10% off next time!`,
        offerCode:  `REVIEW10_${orderId.slice(0, 8)}`,
      });
    }

    return { orderId, userId, customerPhone, customerEmail, flows: steps };
  }

  /**
   * Persist retention flow schedule to DB for background execution.
   */
  async scheduleRetentionFlow(flow: RetentionFlow): Promise<void> {
    try {
      for (const step of flow.flows) {
        const sendAt = new Date(Date.now() + step.delayHours * 3_600_000);
        await this.db.execute(sql`
          INSERT INTO retention_flow_queue (
            order_id, user_id, channel, template_id, message,
            offer_code, send_at, status, created_at
          ) VALUES (
            ${flow.orderId}, ${flow.userId}, ${step.channel},
            ${step.templateId}, ${step.message},
            ${step.offerCode ?? null}, ${sendAt.toISOString()},
            'pending', NOW()
          )
          ON CONFLICT (order_id, template_id) DO NOTHING
        `);
      }

      this.logger.log(
        `[Retention] ✅ Scheduled ${flow.flows.length} retention steps | order=${flow.orderId}`,
      );
    } catch (err) {
      this.logger.warn(`[Retention] Schedule failed: ${(err as Error).message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. DYNAMIC PRICING ENGINE
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Recommend a price adjustment based on real ROAS.
   *
   * ROAS > 3.0 → Test +10% price (demand is inelastic — capture more margin)
   * ROAS 2.0–3.0 → Hold price (sweet spot)
   * ROAS 1.5–2.0 → Test -5% price (may unlock more volume)
   * ROAS < 1.5 → Test -10% price (need to fix unit economics)
   */
  getPricingRecommendation(params: {
    productId:    string;
    currentPrice: number;
    realRoas:     number;
    netProfit:    number;
    supplierPrice: number;
  }): PricingRecommendation {
    const { productId, currentPrice, realRoas, netProfit, supplierPrice } = params;

    // Minimum acceptable margin: 40% of supplier price
    const minAcceptablePrice = supplierPrice * 1.4;

    if (realRoas > 3.0) {
      const newPrice = parseFloat((currentPrice * 1.10).toFixed(2));
      return {
        productId,
        currentPrice,
        recommendedPrice: newPrice,
        delta:   parseFloat((newPrice - currentPrice).toFixed(2)),
        direction: 'increase',
        reason:  `ROAS ${realRoas.toFixed(2)} > 3.0 — demand is strong, test +10% to capture margin`,
        estimatedRoasImpact: +((realRoas * 1.10).toFixed(2)),
      };
    }

    if (realRoas >= 2.0 && realRoas <= 3.0) {
      return {
        productId,
        currentPrice,
        recommendedPrice: currentPrice,
        delta:   0,
        direction: 'hold',
        reason:  `ROAS ${realRoas.toFixed(2)} in sweet spot (2.0–3.0) — price is optimal`,
        estimatedRoasImpact: realRoas,
      };
    }

    if (realRoas >= 1.5) {
      const newPrice = Math.max(
        parseFloat((currentPrice * 0.95).toFixed(2)),
        minAcceptablePrice,
      );
      return {
        productId,
        currentPrice,
        recommendedPrice: newPrice,
        delta:   parseFloat((newPrice - currentPrice).toFixed(2)),
        direction: 'decrease',
        reason:  `ROAS ${realRoas.toFixed(2)} in 1.5–2.0 range — test -5% to increase volume`,
        estimatedRoasImpact: +((realRoas * 1.05).toFixed(2)),
      };
    }

    // ROAS < 1.5 — significant price cut needed
    const newPrice = Math.max(
      parseFloat((currentPrice * 0.90).toFixed(2)),
      minAcceptablePrice,
    );
    return {
      productId,
      currentPrice,
      recommendedPrice: newPrice,
      delta:   parseFloat((newPrice - currentPrice).toFixed(2)),
      direction: 'decrease',
      reason:  `ROAS ${realRoas.toFixed(2)} < 1.5 — test -10% to fix economics (floor: ₹${minAcceptablePrice.toFixed(0)})`,
      estimatedRoasImpact: +((realRoas * 1.12).toFixed(2)),
    };
  }

  /**
   * Apply a pricing recommendation to the product and Shopify.
   * Stores price test record for A/B comparison.
   */
  async applyPricingRecommendation(
    recommendation: PricingRecommendation,
    userId: string,
  ): Promise<void> {
    if (recommendation.direction === 'hold') return;

    try {
      // Store price test record
      await this.db.execute(sql`
        INSERT INTO price_tests (
          product_id, user_id, old_price, new_price, direction,
          reason, status, started_at
        ) VALUES (
          ${recommendation.productId}, ${userId},
          ${recommendation.currentPrice}, ${recommendation.recommendedPrice},
          ${recommendation.direction}, ${recommendation.reason},
          'active', NOW()
        )
        ON CONFLICT (product_id, status) DO UPDATE
          SET new_price = ${recommendation.recommendedPrice},
              direction = ${recommendation.direction},
              reason    = ${recommendation.reason},
              started_at = NOW()
      `);

      // Update product price in DB
      await this.db.execute(sql`
        UPDATE products
        SET selling_price = ${recommendation.recommendedPrice}, updated_at = NOW()
        WHERE id = ${recommendation.productId}
      `);

      this.logger.log(
        `[Pricing] ✅ Price ${recommendation.direction} | ` +
        `product=${recommendation.productId} | ` +
        `₹${recommendation.currentPrice} → ₹${recommendation.recommendedPrice} | ` +
        `reason: ${recommendation.reason}`,
      );
    } catch (err) {
      this.logger.warn(`[Pricing] Apply failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async persistBundleConfig(
    productId: string,
    offers: BundleOffer[],
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO bundle_configs (product_id, offers_json, active, created_at)
      VALUES (${productId}, ${JSON.stringify(offers)}, true, NOW())
      ON CONFLICT (product_id) DO UPDATE
        SET offers_json = ${JSON.stringify(offers)}, active = true, updated_at = NOW()
    `);
  }
}
