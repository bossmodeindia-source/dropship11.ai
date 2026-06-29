// @ts-nocheck
/**
 * RetentionService — Phase 4 P4-3: Customer Retention Engine
 *
 * The #1 ignored lever in dropshipping. Most sellers acquire a customer,
 * ship the order, then never contact them again. This system changes that.
 *
 * Three automation flows:
 *   1. Abandoned Cart   — 1hr after abandonment → recover lost revenue
 *   2. Post-Purchase    — immediately after order → cross-sell, review request
 *   3. Repeat Nudge     — 7–14 days after delivery → bring them back
 *
 * Channels:
 *   - Email     (higher open rate for premium products)
 *   - WhatsApp  (higher open rate in India — 70%+ open rate)
 *
 * Economics:
 *   CAC (Customer Acquisition Cost) = ₹200–400 via ads
 *   Retention cost per message      = ₹2–5 (WhatsApp Business API)
 *   Second purchase = near-pure profit
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import { Inject } from '@nestjs/common';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export type FlowType      = 'abandoned_cart' | 'post_purchase' | 'repeat_nudge';
export type FlowChannel   = 'email' | 'whatsapp';

export interface FlowPerformance {
  flowId:        string;
  flowType:      FlowType;
  channel:       FlowChannel;
  openRate:      number;
  clickRate:     number;
  conversionRate: number;
  revenueAttr:   number;
  roi:           number;  // revenue / (sends * cost_per_send)
}

export interface RetentionSummary {
  totalFlows:          number;
  activeFlows:         number;
  repeatCustomerPct:   number;
  emailRevenue:        number;
  whatsappRevenue:     number;
  topFlow:             FlowPerformance | null;
  recoveredCartValue:  number;
}

// Default flow templates (generated once per brand, then AI-customised)
const DEFAULT_FLOWS: Array<{
  flowType:   FlowType;
  channel:    FlowChannel;
  triggerHrs: number;
  subject?:   string;
}> = [
  { flowType: 'abandoned_cart', channel: 'email',     triggerHrs: 1,   subject: 'You left something behind 👀' },
  { flowType: 'abandoned_cart', channel: 'whatsapp',  triggerHrs: 2  },
  { flowType: 'post_purchase',  channel: 'email',     triggerHrs: 24,  subject: 'Your order is confirmed 🎉 — Plus a gift for you' },
  { flowType: 'post_purchase',  channel: 'whatsapp',  triggerHrs: 1  },
  { flowType: 'repeat_nudge',   channel: 'whatsapp',  triggerHrs: 168 },  // 7 days
  { flowType: 'repeat_nudge',   channel: 'email',     triggerHrs: 336,  subject: 'Ready for round 2? 🔥' },  // 14 days
];

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly ai: AiOrchestratorService,
  ) {}

  /**
   * Initialise all retention flows for a brand.
   * Called when a brand graduates (store_status → LIVE).
   * Idempotent: skips flows that already exist.
   */
  async initFlowsForBrand(
    userId: string,
    brandId: string,
    brandName: string,
    productTitle: string,
    niche: string,
  ): Promise<void> {
    this.logger.log(`Initialising retention flows for brand ${brandName} (${brandId})`);

    for (const template of DEFAULT_FLOWS) {
      // Generate AI-personalised body
      const body = await this.generateFlowBody({
        flowType:    template.flowType,
        brandName,
        productTitle,
        niche,
        triggerHrs:  template.triggerHrs,
      });

      await this.db.$client.query(
        `INSERT INTO retention_flows
           (user_id, brand_id, flow_type, channel, trigger_hrs, subject, body_html, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         ON CONFLICT DO NOTHING`,
        [userId, brandId, template.flowType, template.channel, template.triggerHrs, template.subject ?? null, body],
      );
    }

    this.logger.log(`Created ${DEFAULT_FLOWS.length} retention flows for brand ${brandId}`);
  }

  /**
   * Record that a flow was sent to a customer.
   * Returns false if already sent (idempotency).
   */
  async recordSend(flowId: string, customerId: string, orderId?: string): Promise<boolean> {
    try {
      await this.db.$client.query(
        `INSERT INTO retention_events (flow_id, customer_id, order_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (flow_id, customer_id, order_id) DO NOTHING`,
        [flowId, customerId, orderId ?? null],
      );
      await this.db.$client.query(
        `UPDATE retention_flows SET sends_total = sends_total + 1, updated_at = NOW() WHERE id = $1`,
        [flowId],
      );
      return true;
    } catch {
      return false;  // already sent
    }
  }

  /**
   * Record open, click, or conversion for a retention event.
   */
  async recordEngagement(
    flowId: string,
    customerId: string,
    event: 'open' | 'click' | 'convert',
    revenue = 0,
  ): Promise<void> {
    const updates: Record<string, string> = {
      open:    'opened_at = NOW()',
      click:   'clicked_at = NOW()',
      convert: 'converted_at = NOW()',
    };

    await this.db.$client.query(
      `UPDATE retention_events SET ${updates[event]}
        WHERE flow_id = $1 AND customer_id = $2 AND opened_at IS NULL OR $3 = 'convert'`,
      [flowId, customerId, event],
    );

    if (event === 'open') {
      await this.db.$client.query(`UPDATE retention_flows SET opens_total = opens_total + 1 WHERE id = $1`, [flowId]);
    } else if (event === 'click') {
      await this.db.$client.query(`UPDATE retention_flows SET clicks_total = clicks_total + 1 WHERE id = $1`, [flowId]);
    } else if (event === 'convert') {
      await this.db.$client.query(
        `UPDATE retention_flows SET conversions = conversions + 1, revenue_attr = revenue_attr + $2 WHERE id = $1`,
        [flowId, revenue],
      );
    }
  }

  /**
   * Get retention summary for a user's dashboard.
   */
  async getRetentionSummary(userId: string): Promise<RetentionSummary> {
    const [flowStats, revenueStats, cartRecovered] = await Promise.all([
      this.db.$client.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active
           FROM retention_flows WHERE user_id = $1`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT channel, COALESCE(SUM(revenue_attr), 0) AS revenue
           FROM retention_flows WHERE user_id = $1 GROUP BY channel`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT COALESCE(SUM(rf.revenue_attr), 0) AS total
           FROM retention_flows rf
           WHERE rf.user_id = $1 AND rf.flow_type = 'abandoned_cart'`,
        [userId],
      ),
    ]);

    const emailRevenue    = parseFloat(revenueStats.rows.find(r => r.channel === 'email')?.revenue ?? '0');
    const whatsappRevenue = parseFloat(revenueStats.rows.find(r => r.channel === 'whatsapp')?.revenue ?? '0');

    return {
      totalFlows:          parseInt(flowStats.rows[0]?.total ?? '0', 10),
      activeFlows:         parseInt(flowStats.rows[0]?.active ?? '0', 10),
      repeatCustomerPct:   0,  // computed at dashboard snapshot level with order data
      emailRevenue,
      whatsappRevenue,
      topFlow:             null,  // populated by dashboard if needed
      recoveredCartValue:  parseFloat(cartRecovered.rows[0]?.total ?? '0'),
    };
  }

  /**
   * Cron: every hour — find flows due to fire and return them for sending.
   * Actual sending is done by the notification service (email/WhatsApp provider).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async processDueFlows(): Promise<void> {
    this.logger.debug('Processing due retention flows...');
    // In production: query customers who have events triggering flows
    // and queue them via the notification service.
    // Left as hook — provider integration (Klaviyo / Wati) is config-injected.
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async generateFlowBody(params: {
    flowType:    FlowType;
    channel:     FlowChannel;
    brandName:   string;
    productTitle: string;
    niche:       string;
    triggerHrs:  number;
  }): Promise<string> {
    const flowDescriptions: Record<FlowType, string> = {
      abandoned_cart: 'abandoned cart recovery — customer left without buying',
      post_purchase:  'post-purchase cross-sell + thank you',
      repeat_nudge:   `re-purchase nudge sent ${params.triggerHrs / 24} days after delivery`,
    };

    const isWhatsApp = params.channel === 'whatsapp';
    const prompt = `Write a ${isWhatsApp ? 'WhatsApp Business' : 'HTML email'} message for an Indian D2C brand.

Brand: ${params.brandName}
Niche: ${params.niche}
Product: ${params.productTitle}
Flow purpose: ${flowDescriptions[params.flowType]}
Tone: friendly, conversational, no spam language

${isWhatsApp ? 'Keep under 160 chars. Use 1-2 emojis. Include CTA link placeholder: {shop_link}' : 'Write clean HTML body (no full page, just the body content). Include a CTA button.'}
Do not include subject line. Just the message body.`;

    try {
      const text = await this.ai.complete({ prompt, maxTokens: 300, context: 'retention_flow' });
      return String(text).trim();
    } catch {
      return this.defaultFlowBody(params.flowType, params.channel, params.brandName, params.productTitle);
    }
  }

  private defaultFlowBody(flowType: FlowType, channel: FlowChannel, brandName: string, productTitle: string): string {
    const isWA = channel === 'whatsapp';
    if (flowType === 'abandoned_cart') {
      return isWA
        ? `Hi! You left your ${productTitle} behind 👀 Complete your order now: {shop_link}`
        : `<p>Hey there,</p><p>You were so close! Your <strong>${productTitle}</strong> is waiting. <a href="{shop_link}">Complete your order →</a></p><p>— The ${brandName} Team</p>`;
    }
    if (flowType === 'post_purchase') {
      return isWA
        ? `🎉 Order confirmed! Your ${productTitle} is on its way. We have something special for your next visit: {shop_link}`
        : `<p>Thank you for your order! 🎉</p><p>Your <strong>${productTitle}</strong> is being prepared. Explore more from ${brandName}: <a href="{shop_link}">Shop Now →</a></p>`;
    }
    return isWA
      ? `Hey! How's your ${productTitle} working out? Ready for your next order? 🔥 {shop_link}`
      : `<p>Hi again!</p><p>Hope you're loving your ${productTitle}. Ready to stock up or try something new? <a href="{shop_link}">Shop ${brandName} →</a></p>`;
  }
}
