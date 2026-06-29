/**
 * SubscriptionService
 *
 * Platform-owned Razorpay integration for SaaS subscription billing.
 *
 * CRITICAL DESIGN RULES:
 *   - Platform owns the Razorpay account. Users do NOT connect Razorpay.
 *   - Razorpay is used ONLY for: subscription plans, monthly billing, upgrades.
 *   - NOT used for: customer Shopify purchases, supplier payments.
 *   - Webhook events are idempotent — duplicate events safely ignored.
 *   - Subscription state in DB is authoritative; Razorpay is the billing engine.
 *
 * Plans:
 *   FREE  — 1 bot, organic only, ₹0/month
 *   PRO   — 5 bots, paid + organic, ₹1,999/month
 *   ELITE — unlimited bots, advanced automation, ₹4,999/month
 *
 * Razorpay plan IDs are stored in env vars:
 *   RAZORPAY_PLAN_ID_PRO, RAZORPAY_PLAN_ID_ELITE
 *
 * Fail-safe:
 *   If Razorpay is unreachable, subscription remains in DB state.
 *   PlanGuard reads from DB — not from Razorpay in real-time.
 */

import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and } from 'drizzle-orm';
import Razorpay from 'razorpay';
import * as crypto from 'crypto';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import * as wSchema from '../withdrawal/withdrawal-schema';
import { AuditService } from '../audit/audit.service';
import { AlertingService } from '../alerting/alerting.service';
import {
  SubscriptionPlan,
  SubscriptionStatus,
  PLAN_FEATURES,
} from './dto/subscription.dto';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private readonly razorpay: Razorpay;
  private readonly webhookSecret: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly alerting: AlertingService,
  ) {
    this.razorpay = new Razorpay({
      key_id:     this.config.getOrThrow<string>('RAZORPAY_KEY_ID'),
      key_secret: this.config.getOrThrow<string>('RAZORPAY_KEY_SECRET'),
    });
    this.webhookSecret = this.config.getOrThrow<string>('RAZORPAY_WEBHOOK_SECRET');
  }

  // ── Get Current Subscription Status ──────────────────────────────────────

  async getStatus(userId: string, tenantId: string): Promise<SubscriptionStatus> {
    const [sub] = await this.db
      .select()
      .from(wSchema.userSubscriptions)
      .where(
        and(
          eq(wSchema.userSubscriptions.userId,   userId),
          eq(wSchema.userSubscriptions.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!sub) {
      // Auto-provision free plan on first access
      return this.provisionFreePlan(userId, tenantId);
    }

    const features = PLAN_FEATURES[sub.plan as SubscriptionPlan];
    return {
      plan:                   sub.plan as SubscriptionPlan,
      status:                 sub.status,
      maxBots:                sub.maxBots ?? features.maxBots,
      adsEnabled:             sub.adsEnabled ?? features.adsEnabled,
      advancedAutomation:     sub.advancedAutomation ?? features.advancedAutomation,
      currentPeriodEnd:       sub.currentPeriodEnd,
      cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
      monthlyAmountInr:       parseFloat(sub.monthlyAmountInr ?? '0'),
      razorpaySubscriptionId: sub.razorpaySubscriptionId,
    };
  }

  // ── Create/Upgrade Subscription ───────────────────────────────────────────

  async createOrUpgrade(
    userId: string,
    tenantId: string,
    plan: 'pro' | 'elite',
    ipAddress?: string,
  ): Promise<{ subscriptionId: string; shortUrl: string }> {
    const features = PLAN_FEATURES[plan];
    const planId   = this.getRazorpayPlanId(plan);

    // Fetch or create Razorpay customer
    let customerId = await this.getOrCreateRazorpayCustomer(userId);

    let rzSub: any;
    try {
      rzSub = await this.razorpay.subscriptions.create({
        plan_id:         planId,
        customer_notify: 1,
        total_count:     120, // ~10 years; effectively unlimited
        quantity:        1,
        notes: {
          tenantId,
          userId,
          plan,
          platform: 'aiempire',
        },
      });
    } catch (err: any) {
      this.logger.error(`Razorpay subscription create failed: ${err.message}`);
      await this.alerting.sendCritical({
        title:   '🚨 Razorpay Subscription Failed',
        message: `Failed to create Razorpay subscription for user ${userId}: ${err.message}`,
      });
      throw new ServiceUnavailableException(
        'Subscription service temporarily unavailable. Please try again in a few minutes.',
      );
    }

    // Upsert subscription record in DB
    const [existing] = await this.db
      .select({ id: wSchema.userSubscriptions.id })
      .from(wSchema.userSubscriptions)
      .where(
        and(
          eq(wSchema.userSubscriptions.userId,   userId),
          eq(wSchema.userSubscriptions.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (existing) {
      await this.db
        .update(wSchema.userSubscriptions)
        .set({
          plan,
          status:                'created',
          razorpaySubscriptionId: rzSub.id,
          razorpayPlanId:        planId,
          razorpayCustomerId:    customerId,
          maxBots:               features.maxBots,
          adsEnabled:            features.adsEnabled,
          advancedAutomation:    features.advancedAutomation,
          monthlyAmountInr:      String(features.monthlyAmountInr),
          updatedAt:             new Date(),
        })
        .where(eq(wSchema.userSubscriptions.id, existing.id));
    } else {
      await this.db
        .insert(wSchema.userSubscriptions)
        .values({
          tenantId,
          userId,
          plan,
          status:                'created',
          razorpaySubscriptionId: rzSub.id,
          razorpayPlanId:        planId,
          razorpayCustomerId:    customerId,
          maxBots:               features.maxBots,
          adsEnabled:            features.adsEnabled,
          advancedAutomation:    features.advancedAutomation,
          monthlyAmountInr:      String(features.monthlyAmountInr),
        });
    }

    await this.audit.log({
      tenantId,
      actorId:  userId,
      action:   'SUBSCRIPTION_CREATED',
      resource: 'user_subscriptions',
      severity: 'info',
      details:  { plan, razorpaySubId: rzSub.id },
      ipAddress,
    });

    this.logger.log(`Subscription created: user=${userId} plan=${plan} rzSub=${rzSub.id}`);

    return {
      subscriptionId: rzSub.id,
      shortUrl:       rzSub.short_url ?? '',
    };
  }

  // ── Cancel Subscription ───────────────────────────────────────────────────

  /** Original cancel — kept for backwards compat */
  async cancel(
    userId: string,
    tenantId: string,
    immediate = false,
    ipAddress?: string,
  ): Promise<void> {
    const [sub] = await this.db
      .select()
      .from(wSchema.userSubscriptions)
      .where(
        and(
          eq(wSchema.userSubscriptions.userId,   userId),
          eq(wSchema.userSubscriptions.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!sub) throw new NotFoundException('No active subscription found');

    if (sub.plan === 'free') {
      throw new BadRequestException('Free plan cannot be cancelled');
    }

    if (sub.razorpaySubscriptionId) {
      try {
        await (this.razorpay.subscriptions as unknown as { cancel(id:string,opts:Record<string,unknown>):Promise<unknown> }).cancel(
          sub.razorpaySubscriptionId,
          { cancel_at_cycle_end: immediate ? 0 : 1 },
        );
      } catch (err: any) {
        this.logger.error(`Razorpay cancel failed: ${err.message}`);
        // Don't throw — update DB state regardless
      }
    }

    await this.db
      .update(wSchema.userSubscriptions)
      .set({
        cancelAtPeriodEnd: Boolean(!immediate),
        status:            immediate ? 'cancelled' : sub.status,
        plan:              immediate ? 'free' : sub.plan,
        maxBots:           immediate ? 1 : sub.maxBots,
        adsEnabled:        immediate ? false : sub.adsEnabled,
        advancedAutomation: immediate ? false : sub.advancedAutomation,
        monthlyAmountInr:  immediate ? '0' : sub.monthlyAmountInr,
        updatedAt:         new Date(),
      })
      .where(eq(wSchema.userSubscriptions.id, sub.id));

    await this.audit.log({
      tenantId,
      actorId:  userId,
      action:   'SUBSCRIPTION_CANCELLED',
      resource: 'user_subscriptions',
      severity: 'info',
      details:  { plan: sub.plan, immediate },
      ipAddress,
    });
  }

  // ── Razorpay Webhook Handler ───────────────────────────────────────────────

  /**
   * Verifies Razorpay webhook signature and processes event idempotently.
   * Must be called with the raw request body (before JSON.parse).
   */
  async handleWebhook(rawBody: string, signature: string): Promise<void> {
    // ── Signature verification ─────────────────────────────────────────────
    const expectedSig = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSig) {
      this.logger.warn('[Razorpay Webhook] Invalid signature — rejected');
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody);
    const eventId   = event.id   as string;
    const eventType = event.event as string;

    // ── Idempotency check ─────────────────────────────────────────────────
    const [existing] = await this.db
      .select({ id: wSchema.razorpayWebhookEvents.id })
      .from(wSchema.razorpayWebhookEvents)
      .where(eq(wSchema.razorpayWebhookEvents.eventId, eventId))
      .limit(1);

    if (existing) {
      this.logger.debug(`[Razorpay Webhook] Duplicate event ${eventId} — skipped`);
      return;
    }

    // Persist event record before processing
    await this.db
      .insert(wSchema.razorpayWebhookEvents)
      .values({
        eventId,
        eventType,
        payload:  event,
        processed: false,
      });

    // ── Route by event type ─────────────────────────────────────────────
    try {
      switch (eventType) {
        case 'subscription.activated':
        case 'subscription.charged':
          await this.onSubscriptionActivated(event);
          break;
        case 'subscription.cancelled':
          await this.onSubscriptionCancelled(event);
          break;
        case 'payment.failed':
          await this.onPaymentFailed(event);
          break;
        default:
          this.logger.debug(`[Razorpay Webhook] Unhandled event type: ${eventType}`);
      }

      // Mark processed
      await this.db
        .update(wSchema.razorpayWebhookEvents)
        .set({ processed: true, processedAt: new Date() })
        .where(eq(wSchema.razorpayWebhookEvents.eventId, eventId));

    } catch (err: any) {
      await this.db
        .update(wSchema.razorpayWebhookEvents)
        .set({ error: err.message })
        .where(eq(wSchema.razorpayWebhookEvents.eventId, eventId));

      this.logger.error(`[Razorpay Webhook] Error processing ${eventId}: ${err.message}`);
      throw err;
    }
  }

  // ── Private: Webhook Handlers ─────────────────────────────────────────────

  private async onSubscriptionActivated(event: Record<string,unknown>): Promise<void> {
    const sub = (((event['payload'] as Record<string,unknown>|undefined)?.['subscription'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    if (!sub?.['id']) return;

    const rzSubId = sub['id'] as string;
    const tenantId = (sub['notes'] as Record<string,unknown>|undefined)?.['tenantId'] as string;
    const userId   = (sub['notes'] as Record<string,unknown>|undefined)?.['userId']   as string;

    if (!tenantId || !userId) {
      this.logger.warn(`[Razorpay Webhook] subscription.activated: missing notes metadata`);
      return;
    }

    const _currentEnd = sub['current_end'] as number | undefined;
    const currentPeriodEnd = _currentEnd != null ? new Date(_currentEnd * 1000) : null;

    await this.db
      .update(wSchema.userSubscriptions)
      .set({
        status:             'active',
        currentPeriodStart: (sub['current_start'] as number | undefined) != null ? new Date((sub['current_start'] as number) * 1000) : null,
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
        updatedAt:          new Date(),
      })
      .where(eq(wSchema.userSubscriptions.razorpaySubscriptionId, rzSubId));

    this.logger.log(`Subscription activated: rzSubId=${rzSubId} tenant=${tenantId}`);
  }

  private async onSubscriptionCancelled(event: Record<string,unknown>): Promise<void> {
    const sub   = (((event['payload'] as Record<string,unknown>|undefined)?.['subscription'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    const rzSubId = sub?.['id'] as string;
    if (!rzSubId) return;

    await this.db
      .update(wSchema.userSubscriptions)
      .set({
        status:            'cancelled',
        plan:              'free',
        maxBots:           1,
        adsEnabled:        false,
        advancedAutomation: false,
        monthlyAmountInr:  '0',
        updatedAt:         new Date(),
      })
      .where(eq(wSchema.userSubscriptions.razorpaySubscriptionId, rzSubId));

    this.logger.log(`Subscription cancelled: rzSubId=${rzSubId}`);
  }

  private async onPaymentFailed(event: Record<string,unknown>): Promise<void> {
    const payment = (((event['payload'] as Record<string,unknown>|undefined)?.['payment'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    const subId   = payment?.['subscription_id'] as string;

    await this.alerting.sendCritical({
      title:   '⚠️ Subscription Payment Failed',
      message: `Razorpay payment failed for subscription ${subId}. Amount: ₹${(payment?.['amount'] as number ?? 0) / 100}`,
    });

    this.logger.warn(`Payment failed: paymentId=${payment?.['id']} subId=${subId}`);
  }

  // ── Private: Helpers ──────────────────────────────────────────────────────

  private async provisionFreePlan(userId: string, tenantId: string): Promise<SubscriptionStatus> {
    const features = PLAN_FEATURES.free;
    await this.db
      .insert(wSchema.userSubscriptions)
      .values({
        userId,
        tenantId,
        plan:              'free',
        status:            'active',
        maxBots:           features.maxBots,
        adsEnabled:        features.adsEnabled,
        advancedAutomation: features.advancedAutomation,
        monthlyAmountInr:  '0',
      })
      .onConflictDoNothing();

    return {
      plan:                   'free',
      status:                 'active',
      maxBots:                features.maxBots,
      adsEnabled:             features.adsEnabled,
      advancedAutomation:     features.advancedAutomation,
      currentPeriodEnd:       null,
      cancelAtPeriodEnd: false,
      monthlyAmountInr:       0,
      razorpaySubscriptionId: null,
    };
  }

  private async getOrCreateRazorpayCustomer(userId: string): Promise<string> {
    // In production: look up existing customer ID from DB and return it.
    // For brevity, we create a new one here — extend with DB lookup as needed.
    const [user] = await this.db
      .select({ email: schema.users.email, fullName: schema.users.fullName })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    const customer = await (this.razorpay.customers as unknown as { create(opts:Record<string,unknown>):Promise<{id:string}> }).create({
      name:    user?.fullName ?? 'AI Empire User',
      email:   user?.email ?? '',
      contact: '',
      notes:   { userId, platform: 'aiempire' },
    });

    return customer.id;
  }

  private getRazorpayPlanId(plan: 'pro' | 'elite'): string {
    const envKey = `RAZORPAY_PLAN_ID_${plan.toUpperCase()}`;
    return this.config.getOrThrow<string>(envKey);
  }

  // ── V60 Razorpay webhook aliases ───────────────────────────────────────────
  async recordPayment(payload: { paymentId: string; orderId?: string; amount?: number; currency?: string; status?: string }): Promise<void> {
    this.logger.log(`recordPayment paymentId=${payload.paymentId}`);
    await this.onSubscriptionActivated(payload);
  }
  async recordPaymentFailure(payload: { paymentId: string; orderId?: string; reason?: string }): Promise<void> {
    this.logger.warn(`recordPaymentFailure paymentId=${payload.paymentId}`);
    await this.onPaymentFailed(payload);
  }
  async activate(payload: { razorpaySubscriptionId: string; planId: string; startAt?: Date; endAt?: Date }): Promise<void> {
    this.logger.log(`activate sub=${payload.razorpaySubscriptionId}`);
    await this.onSubscriptionActivated(payload);
  }
  async recordRecurringCharge(payload: { razorpaySubscriptionId: string; paymentId: string; amount?: number; currency?: string }): Promise<void> {
    this.logger.log(`recordRecurringCharge sub=${payload.razorpaySubscriptionId}`);
  }
  async recordRefund(payload: { refundId: string; paymentId?: string; amount?: number }): Promise<void> {
    this.logger.warn(`recordRefund refundId=${payload.refundId}`);
    await this.onSubscriptionCancelled(payload);
  }

  async cancelSubscription(payload: { razorpaySubscriptionId?: string; userId?: string; tenantId?: string; reason?: string }): Promise<void> {
    if (payload.userId && payload.tenantId) {
    await this.cancel(payload.userId, payload.tenantId);
    }
  }
}
