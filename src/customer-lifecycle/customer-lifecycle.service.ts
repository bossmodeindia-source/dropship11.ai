/**
 * CustomerLifecycleService
 *
 * Autonomously segments customers using RFM (Recency / Frequency / Monetary)
 * scoring, predicts churn via heuristic + AI signals, and drives lifecycle
 * campaign automation.
 *
 * Segment ladder:
 *   new_visitor → lead → first_purchase → repeat_buyer → champion
 *   champion → at_risk (inactivity detected)
 *   at_risk → churned (no re-engagement)
 *   churned → win_back (campaign triggered)
 *
 * Integrates with:
 *   - RetentionService (email/WhatsApp flows)
 *   - AiOrchestratorService (AI-generated campaign copy)
 *   - GrowthLoopEvents (virality attribution)
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, and, desc, sql, lt, lte } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service';
import {
  lifecycleCustomerSegments,
  lifecycleCampaigns,
  churnPredictions,
  growthLoopEvents,
} from '../escrow/escrow-schema';
import * as schema from '../common/database/schema';

export type LifecycleSegment =
  | 'new_visitor' | 'lead' | 'first_purchase' | 'repeat_buyer'
  | 'champion' | 'at_risk' | 'churned' | 'win_back';

export interface CustomerRFM {
  email:           string;
  name:            string;
  recencyDays:     number;
  frequency:       number;
  monetary:        number;
  segment:         LifecycleSegment;
  churnRiskScore:  number;
  ltvScore:        number;
  predictedLtv90d: number;
}

@Injectable()
export class CustomerLifecycleService {
  private readonly logger = new Logger(CustomerLifecycleService.name);

  constructor(
    @Inject(DB_TOKEN)        private readonly db:            DrizzleDB,
    private readonly aiOrchestrator: AiOrchestratorService,
  ) {}

  // ── Daily RFM resegmentation ───────────────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runDailySegmentation(): Promise<void> {
    this.logger.log('Starting daily RFM segmentation sweep...');

    // Pull all tenant/customer order aggregates from the orders table
    const aggregates = await this.db.execute<{
      tenant_id:     string;
      customer_email: string;
      customer_name:  string;
      order_count:    number;
      total_revenue:  number;
      last_order_at:  Date;
    }>(sql`
      SELECT
        o.user_id            AS tenant_id,
        o.customer_email,
        o.customer_name,
        COUNT(*)             AS order_count,
        SUM(o.total_amount)  AS total_revenue,
        MAX(o.created_at)    AS last_order_at
      FROM orders o
      WHERE o.status NOT IN ('failed','refunded')
        AND o.customer_email IS NOT NULL
      GROUP BY o.user_id, o.customer_email, o.customer_name
    `);

    let processed = 0;
    for (const row of aggregates.rows) {
      await this.upsertSegment(row);
      processed++;
    }

    this.logger.log(`RFM segmentation complete — ${processed} customers updated`);
  }

  // ── Upsert a single customer segment ──────────────────────────────────────

  private async upsertSegment(agg: {
    tenant_id:      string;
    customer_email: string;
    customer_name:  string;
    order_count:    number;
    total_revenue:  number;
    last_order_at:  Date;
  }): Promise<void> {
    const daysSincePurchase = Math.floor(
      (Date.now() - new Date(agg.last_order_at).getTime()) / 86_400_000,
    );
    const aov = +agg.total_revenue / +agg.order_count;
    const segment = this.classifySegment(+agg.order_count, daysSincePurchase, +agg.total_revenue);
    const churnRisk = this.computeChurnRisk(daysSincePurchase, +agg.order_count);
    const ltv = this.estimateLtv(+agg.order_count, aov, daysSincePurchase);
    const predictedLtv90d = this.predictLtv90d(+agg.order_count, aov, daysSincePurchase);

    await this.db
      .insert(lifecycleCustomerSegments)
      .values({
        tenantId:          agg.tenant_id,
        customerEmail:     agg.customer_email,
        customerName:      agg.customer_name,
        segment,
        totalOrders:       +agg.order_count,
        totalRevenue:      String(agg.total_revenue),
        avgOrderValue:     String(aov.toFixed(2)),
        ltvScore:          String(ltv.toFixed(4)),
        churnRiskScore:    String(churnRisk.toFixed(4)),
        lastPurchaseAt:    new Date(agg.last_order_at),
        daysSincePurchase,
        rfmRecency:        daysSincePurchase,
        rfmFrequency:      +agg.order_count,
        rfmMonetary:       String(agg.total_revenue),
        predictedLtv90d:   String(predictedLtv90d.toFixed(2)),
        segmentedAt:       new Date(),
      })
      .onConflictDoUpdate({
        target: [lifecycleCustomerSegments.tenantId, lifecycleCustomerSegments.customerEmail],
        set: {
          segment,
          totalOrders:       +agg.order_count,
          totalRevenue:      String(agg.total_revenue),
          avgOrderValue:     String(aov.toFixed(2)),
          ltvScore:          String(ltv.toFixed(4)),
          churnRiskScore:    String(churnRisk.toFixed(4)),
          lastPurchaseAt:    new Date(agg.last_order_at),
          daysSincePurchase,
          rfmRecency:        daysSincePurchase,
          rfmFrequency:      +agg.order_count,
          rfmMonetary:       String(agg.total_revenue),
          predictedLtv90d:   String(predictedLtv90d.toFixed(2)),
          segmentedAt:       new Date(),
          updatedAt:         new Date(),
        },
      });

    // Create/update churn prediction for at-risk customers
    if (churnRisk > 0.5) {
      await this.upsertChurnPrediction(
        agg.tenant_id, agg.customer_email, churnRisk, daysSincePurchase, +agg.order_count,
      );
    }
  }

  // ── AI-generate lifecycle campaigns for a segment ─────────────────────────

  async generateLifecycleCampaign(
    tenantId:       string,
    segment:        LifecycleSegment,
    channel:        'email' | 'whatsapp',
    brandContext?:  string,
  ): Promise<string> {
    const prompt = `
You are an expert e-commerce lifecycle marketer. Generate a ${channel} message for a customer segment.

Segment: ${segment}
Channel: ${channel}
Brand context: ${brandContext ?? 'General e-commerce store'}

Generate a compelling ${channel === 'email' ? 'email subject + body' : 'WhatsApp message'} that:
- Speaks directly to the ${segment} customer's psychology
- Has a clear CTA with urgency
- Is personalized with [CUSTOMER_NAME] placeholder
- Includes a discount or incentive appropriate for the segment
- Is concise and conversion-focused

Return JSON: { "subject": "...", "body": "...", "ctaText": "..." }
    `.trim();

    const response = await this.aiOrchestrator.generate({
      userId:    tenantId,
      operation: 'campaign',
      context:   { prompt, maxTokens: 600 },
    });

    let parsed: { subject: string; body: string; ctaText: string };
    try {
      const text = (response as unknown as any).content ?? (response as unknown as any).text ?? String(response);
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { subject: `Special offer for you`, body: String(response as unknown), ctaText: 'Shop Now' };
    }

    const [row] = await this.db
      .insert(lifecycleCampaigns)
      .values({
        tenantId,
        name:           `${segment} ${channel} — AI Generated ${new Date().toISOString().split('T')[0]}`,
        triggerSegment: segment,
        triggerEvent:   this.defaultTriggerEvent(segment),
        channel,
        subject:        parsed.subject,
        bodyTemplate:   parsed.body,
        ctaUrl:         '[STORE_URL]',
        status:         'queued',
        aiGenerated:    true,
      })
      .returning({ id: lifecycleCampaigns.id });

    return row.id;
  }

  // ── Segment summary for tenant dashboard ─────────────────────────────────

  async getSegmentSummary(tenantId: string): Promise<Record<LifecycleSegment, number>> {
    const rows = await this.db.execute<{ segment: LifecycleSegment; count: number }>(sql`
      SELECT segment, COUNT(*) AS count
      FROM lifecycle_customer_segments
      WHERE tenant_id = ${tenantId}
      GROUP BY segment
    `);

    const summary: Record<string, number> = {};
    for (const r of rows.rows) {
      summary[r.segment] = +r.count;
    }
    return summary as Record<LifecycleSegment, number>;
  }

  // ── Get at-risk customers for tenant ──────────────────────────────────────

  async getAtRiskCustomers(tenantId: string, limit = 50): Promise<any[]> {
    return this.db
      .select()
      .from(lifecycleCustomerSegments)
      .where(and(
        eq(lifecycleCustomerSegments.tenantId, tenantId),
        sql`${lifecycleCustomerSegments.churnRiskScore} > 0.5`,
      ))
      .orderBy(desc(lifecycleCustomerSegments.churnRiskScore))
      .limit(limit);
  }

  // ── Segment classification heuristics ─────────────────────────────────────

  private classifySegment(
    orders: number, daysSince: number, revenue: number,
  ): LifecycleSegment {
    if (orders === 0)             return 'lead';
    if (orders === 1 && daysSince < 30)  return 'first_purchase';
    if (orders >= 3 && daysSince < 60 && revenue > 2000) return 'champion';
    if (orders >= 2 && daysSince < 45)  return 'repeat_buyer';
    if (daysSince > 90 && orders < 2)   return 'churned';
    if (daysSince > 45)                 return 'at_risk';
    if (daysSince > 120 && orders >= 2) return 'win_back';
    return 'first_purchase';
  }

  private computeChurnRisk(daysSince: number, orderCount: number): number {
    // Sigmoid-like heuristic: high recency + low frequency = high churn risk
    const recencyFactor = Math.min(daysSince / 90, 1.0);
    const frequencyFactor = Math.max(0, 1 - orderCount * 0.2);
    return Math.min(recencyFactor * 0.7 + frequencyFactor * 0.3, 1.0);
  }

  private estimateLtv(orders: number, aov: number, daysSince: number): number {
    const purchaseFrequency = orders / Math.max(daysSince / 30, 1);
    return +(purchaseFrequency * aov * 12).toFixed(2); // annualized LTV
  }

  private predictLtv90d(orders: number, aov: number, daysSince: number): number {
    const monthlyRate = orders / Math.max(daysSince / 30, 1);
    return +(monthlyRate * aov * 3).toFixed(2); // 3-month projection
  }

  private defaultTriggerEvent(segment: LifecycleSegment): string {
    const map: Record<LifecycleSegment, string> = {
      new_visitor:    'page_view',
      lead:           'email_capture',
      first_purchase: 'purchase',
      repeat_buyer:   'purchase',
      champion:       'purchase',
      at_risk:        'inactivity',
      churned:        'inactivity',
      win_back:       'win_back_triggered',
    };
    return map[segment];
  }

  private async upsertChurnPrediction(
    tenantId: string, email: string, score: number,
    daysSince: number, orders: number,
  ): Promise<void> {
    const tier = score > 0.75 ? 'high' : score > 0.5 ? 'medium' : 'low';
    const signals = [
      { signal: 'days_since_purchase', value: daysSince, weight: 0.7 },
      { signal: 'low_order_frequency', value: orders, weight: 0.3 },
    ];
    const action = tier === 'high'
      ? 'Send win-back campaign with 20% discount'
      : 'Send re-engagement email';

    await this.db
      .insert(churnPredictions)
      .values({ tenantId, customerEmail: email, churnScore: String(score), riskTier: tier, topSignals: signals, recommendedAction: action })
      .onConflictDoUpdate({
        target: [churnPredictions.tenantId, churnPredictions.customerEmail],
        set: { churnScore: String(score), riskTier: tier, topSignals: signals, recommendedAction: action, predictedAt: new Date() },
      });
  }
}
