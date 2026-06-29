/**
 * razorpay-subscription-webhook.controller.ts — V60 RAZORPAY SUBSCRIPTION WEBHOOK HANDLER
 *
 * P0-2: Uses rawBody captured in main.ts BEFORE json parsing for HMAC.
 * Timing-safe HMAC comparison prevents signature oracle attacks.
 *
 * Events handled:
 *   payment.captured         → activate subscription
 *   payment.failed           → deactivate / alert
 *   subscription.activated   → grant plan access
 *   subscription.cancelled   → revoke plan access
 *   subscription.charged     → record recurring revenue
 *   subscription.pending     → no-op (wait for captured)
 *   refund.processed         → reverse revenue
 */

import {
  Controller, Post, Headers, Body, Req,
  UnauthorizedException, HttpCode, HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request }               from 'express';
import { Public }                from '../common/decorators/public.decorator';
import { createHmac, timingSafeEqual } from 'crypto';
import { Redis }                 from 'ioredis';
import { InjectRedis }           from '../common/redis/inject-redis';
import { ConfigService }           from '@nestjs/config';
import { WebhookIdempotencyService } from '../common/webhook/webhook-idempotency.service';
import { SubscriptionService }   from '../subscription/subscription.service';
import { UnifiedFinanceEngine }  from '../finance/unified-finance-engine.service';
import { AlertingService }       from '../alerting/alerting.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@ApiTags('Webhooks')
@Controller('webhooks/razorpay/subscriptions')
export class RazorpaySubscriptionWebhookController {
  private readonly logger = new Logger(RazorpaySubscriptionWebhookController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly config:       ConfigService,
    private readonly subscription: SubscriptionService,
    private readonly finance:      UnifiedFinanceEngine,
    private readonly alerting:     AlertingService,
    @InjectRedis() private readonly redis: Redis,
    private readonly webhookIdempotency: WebhookIdempotencyService,
  ) {
    this.webhookSecret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET', '');
    if (!this.webhookSecret) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET must be set — webhook validation will fail');
    }
  }

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay subscription webhook endpoint' })
  async handleWebhook(
    @Headers('x-razorpay-signature') signature: string,
    @Body() body: Record<string, unknown>,
    @Req() req: RawBodyRequest,
  ) {
    // ── HMAC validation using rawBody (set in main.ts before json parser) ─
    if (!req.rawBody) {
      this.logger.error('rawBody not available — raw body middleware not configured');
      throw new UnauthorizedException('Invalid webhook: raw body unavailable');
    }

    await this.validateHmac(req.rawBody, signature);

    const event   = String(body['event'] ?? '');
    const payload = body['payload'] as Record<string, unknown> ?? {};
    const entityId = this.extractEntityId(event, payload);

    // ── Replay protection ─────────────────────────────────────────────────
    const dedupeKey = `razorpay:webhook:${event}:${entityId}`;
    if (await this.isAlreadyProcessed(dedupeKey)) {
      this.logger.debug(`Duplicate Razorpay webhook ignored: ${dedupeKey}`);
      return { status: 'already_processed' };
    }

    this.logger.log(`Razorpay event: ${event} entity=${entityId}`);

    try {
      switch (event) {
        case 'payment.captured':
          await this.handlePaymentCaptured(payload);
          break;

        case 'payment.failed':
          await this.handlePaymentFailed(payload);
          break;

        case 'subscription.activated':
          await this.handleSubscriptionActivated(payload);
          break;

        case 'subscription.cancelled':
          await this.handleSubscriptionCancelled(payload);
          break;

        case 'subscription.charged':
          await this.handleSubscriptionCharged(payload);
          break;

        case 'refund.processed':
          await this.handleRefund(payload);
          break;

        default:
          this.logger.debug(`Unhandled Razorpay event: ${event}`);
      }

      await this.markProcessed(dedupeKey);
      return { status: 'processed', event };
    } catch (err) {
      this.logger.error(`Razorpay webhook error: event=${event}`, err);
      // Do NOT return error status — Razorpay will retry on non-200
      // Instead log and return 200, handle via alerting
      await this.alerting.sendCritical({ title: 'RAZORPAY_WEBHOOK_ERROR', message: 'platform error', data: {
        event, entityId, error: (err as Error).message,
      } });
      return { status: 'error_logged' };
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  private async handlePaymentCaptured(payload: Record<string, unknown>): Promise<void> {
    const payment = ((payload['payment'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    if (!payment) return;

    await this.subscription.recordPayment({
      paymentId:   payment['id'] as string,
      orderId:     payment['order_id'] as string | undefined,
      amount:      payment['amount'] as number | undefined,
      currency:    payment['currency'] as string | undefined,
      status:      'captured',
    });
  }

  private async handlePaymentFailed(payload: Record<string, unknown>): Promise<void> {
    const payment = ((payload['payment'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    if (!payment) return;

    await this.subscription.recordPaymentFailure({
      paymentId: payment['id'] as string,
      orderId:   payment['order_id'] as string | undefined,
      reason:    (payment['error_description'] as string | undefined) ?? 'Payment failed',
    });

    const userId = (payment['notes'] as Record<string,unknown>|undefined)?.['user_id'] as string | undefined;
    if (userId) {
      await this.alerting.sendWarn({ title: 'PAYMENT_FAILED', message: 'Payment failed for user ' + userId, data: {
        paymentId: payment['id'] as string,
        amount:    payment['amount'] as number | undefined,
      } });
    }
  }

  private async handleSubscriptionActivated(payload: Record<string, unknown>): Promise<void> {
    const sub = ((payload['subscription'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    if (!sub) return;

    await this.subscription.activate({
      razorpaySubscriptionId: sub['id'] as string,
      planId:                 (sub['plan_id'] as string | undefined) ?? '',
      startAt:                new Date((sub['start_at'] as number) * 1000),
      endAt:                  new Date((sub['end_at']   as number) * 1000),
    });
  }

  private async handleSubscriptionCancelled(payload: Record<string, unknown>): Promise<void> {
    const sub = ((payload['subscription'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    if (!sub) return;

    await this.subscription.cancelSubscription({ razorpaySubscriptionId: sub['id'] as string });
  }

  private async handleSubscriptionCharged(payload: Record<string, unknown>): Promise<void> {
    const sub     = ((payload['subscription'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    const payment = ((payload['payment'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    if (!sub || !payment) return;

    await this.subscription.recordRecurringCharge({
      razorpaySubscriptionId: sub['id'] as string,
      paymentId:              payment['id'] as string,
      amount:                 payment['amount'] as number | undefined,
      currency:               payment['currency'] as string | undefined,
    });
  }

  private async handleRefund(payload: Record<string, unknown>): Promise<void> {
    const refund = ((payload['refund'] as Record<string,unknown>|undefined)?.['entity'] as Record<string,unknown>|undefined);
    if (!refund) return;

    await this.subscription.recordRefund({
      refundId:  refund['id'] as string,
      paymentId: refund['payment_id'] as string,
      amount:    refund['amount'] as number | undefined,
    });
  }

  // ── HMAC validation ───────────────────────────────────────────────────────

  private async validateHmac(rawBody: Buffer, signature: string): Promise<void> {
    if (!signature) {
      throw new UnauthorizedException('Missing x-razorpay-signature header');
    }

    const computed = createHmac('sha256', this.webhookSecret)
      .update(rawBody.toString('utf8'))
      .digest('hex');

    const computedBuf = Buffer.from(computed, 'hex');
    const providedBuf = Buffer.from(signature, 'hex');

    if (
      computedBuf.length !== providedBuf.length ||
      !timingSafeEqual(computedBuf, providedBuf)
    ) {
      this.logger.warn('Razorpay webhook HMAC validation failed');
      throw new UnauthorizedException('Invalid Razorpay webhook signature');
    }
  }

  private extractEntityId(event: string, payload: Record<string, unknown>): string {
    const [type] = event.split('.');
    const entity = ((payload[type] as Record<string,unknown>|undefined)?.['entity']) as Record<string,unknown>|undefined;
    return (entity?.['id'] as string | undefined) ?? 'unknown';
  }

  private async isAlreadyProcessed(key: string): Promise<boolean> {
    return (await this.redis.get(key)) !== null;
  }

  private async markProcessed(key: string): Promise<void> {
    await this.redis.set(key, '1', 'EX', 604_800); // 7 days
  }
}
