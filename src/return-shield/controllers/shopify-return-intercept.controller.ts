/**
 * ShopifyReturnInterceptController — V64
 *
 * ⚠️  CRITICAL SECURITY OVERRIDE ⚠️
 *
 * Intercepts ALL Shopify return/refund/cancellation webhooks and routes
 * them into the Return Shield HOLDING PIPELINE.
 *
 * REGISTRATION PRIORITY:
 *   These routes MUST be registered in Shopify BEFORE or INSTEAD OF any
 *   auto-refund webhook handlers. The V64 ShopifyReturnWebhookController
 *   (which called OrderRefundService) must be disabled — this replaces it.
 *
 * Shopify webhook topics to register:
 *   refunds/create    → POST /webhooks/shopify/return-shield/refunds/intercept
 *   returns/create    → POST /webhooks/shopify/return-shield/returns/intercept
 *   orders/cancelled  → POST /webhooks/shopify/return-shield/orders/cancelled
 *
 * FINANCIAL SAFETY CONTRACT:
 *   ✅ Validates Shopify HMAC-SHA256 signature (using rawBody)
 *   ✅ Deduplicates via Redis (7-day TTL)
 *   ✅ Creates RETURN_REQUEST in RETURN_PROCESSING state
 *   ✅ Returns 202 Accepted to stop Shopify retry storm
 *   ✅ Immutably logs what was PREVENTED (auto-refund, auto-inventory, etc.)
 *
 *   ❌ NEVER calls Razorpay refund API
 *   ❌ NEVER updates Shopify financial status
 *   ❌ NEVER notifies supplier to reverse order
 *   ❌ NEVER reverses inventory or stock
 *   ❌ NEVER modifies escrow, commissions, or payouts
 *   ❌ NEVER auto-approves the return
 */

import {
  Controller, Post, Headers, RawBody,
  UnauthorizedException, HttpCode, HttpStatus,
  Logger, Inject, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation }        from '@nestjs/swagger';
import { createHmac, timingSafeEqual }  from 'crypto';
import { ConfigService }                from '@nestjs/config';
<<<<<<< HEAD
import { InjectRedis }                  from '../../common/redis/inject-redis';
=======
import { InjectRedis }                  from '@liaoliaots/nestjs-redis';
>>>>>>> a1b8c0c1cff445126259345924e07d81a359e9bd
import { Redis }                        from 'ioredis';

import { DB_TOKEN, DrizzleDB }          from '../../common/database/database.module';
import { sql }                           from 'drizzle-orm';
import { Public }                       from '../../common/decorators/public.decorator';
import { ShopifyApiKeysService }        from '../../shopify/shopify-api-keys.service';
import { ReturnRequestService }         from '../services/return-request.service';
import { ReturnAuditService }           from '../services/return-audit.service';
import {
  CreateReturnRequestDto,
  ReturnReason,
} from '../dto/return-shield.dto';

// Redis TTL for idempotency keys (7 days — matches Shopify retry window)
const DEDUP_TTL_SECONDS = 604_800;

@ApiTags('Webhooks — Return Shield (Shopify Override)')
@Controller('webhooks/shopify/return-shield')
export class ShopifyReturnInterceptController {
  private readonly logger    = new Logger(ShopifyReturnInterceptController.name);
  private readonly fallbackSecret: string;

  constructor(
    private readonly config:        ConfigService,
    private readonly apiKeys:       ShopifyApiKeysService,
    private readonly returnService: ReturnRequestService,
    private readonly returnAudit:   ReturnAuditService,
    @Inject(DB_TOKEN)     private readonly db:    DrizzleDB,
    @InjectRedis()        private readonly redis: Redis,
  ) {
    this.fallbackSecret = this.config.get<string>('SHOPIFY_WEBHOOK_SECRET', '');
  }

  // ── POST refunds/intercept ───────────────────────────────────────────────
  // Intercepts Shopify refunds/create — BLOCKS automatic refund execution.

  @Post('refunds/intercept')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Intercept Shopify refund webhook — routes to admin queue, NO auto-refund' })
  async interceptRefundCreated(
    @Headers('x-shopify-hmac-sha256') hmacHeader: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @RawBody() rawBody: Buffer,
  ) {
    await this.validateHmac(rawBody, hmacHeader, shopDomain);

    const payload       = this.parseBody(rawBody);
    const shopifyRefId  = String(payload.id);
    const shopifyOrdId  = String(payload.order_id);
    const dedupeKey     = `returnshield:refund:${shopifyRefId}`;

    const isNew = await this.redis.set(dedupeKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    if (!isNew) {
      this.logger.debug(`Duplicate refund webhook skipped: ${shopifyRefId}`);
      return { status: 'already_intercepted' };
    }

    try {
      const { order, tenantId } = await this.resolveOrder(shopifyOrdId);

      if (!order) {
        this.logger.warn(`Return shield: order ${shopifyOrdId} not found — logging and acknowledging`);
        await this.returnAudit.logShopifyReturnIntercepted({
          tenantId:       shopDomain ?? 'unknown',
          shopifyOrderId: shopifyOrdId,
          topic:          'refunds/create',
        });
        // Return 200 so Shopify stops retrying an order we don't own
        return {
          status:  'intercepted',
          message: 'Order not found. Auto-refund BLOCKED. Logged for review.',
        };
      }

      const dto: CreateReturnRequestDto = {
        orderId:        order.id,
        reasonCategory: ReturnReason.OTHER,
        reason:         payload.note
          ?? `Shopify refund webhook intercepted. Refund ID: ${shopifyRefId}`,
        notes:
          `Shopify refunds/create intercepted. ` +
          `Amount: ${payload.transactions?.[0]?.amount ?? 'unknown'}. ` +
          `Auto-refund BLOCKED by Return Shield.`,
      };

      const result = await this.returnService.createReturnRequest({
        customerId: order.customer_id,
        tenantId,
        dto,
      });

      await this.returnAudit.logShopifyReturnIntercepted({
        tenantId,
        shopifyOrderId:  shopifyOrdId,
        topic:           'refunds/create',
        returnRequestId: result.returnRequestId,
      });

      this.logger.log(
        `🛡️  REFUND INTERCEPTED | shopifyOrder=${shopifyOrdId} ` +
        `refundId=${shopifyRefId} returnId=${result.returnRequestId} ` +
        `autoRefund=BLOCKED autoSupplier=BLOCKED`,
      );

      return {
        status:          'intercepted',
        returnRequestId: result.returnRequestId,
        autoRefund:      false,
        autoSupplier:    false,
        financialState:  'unchanged',
        message:         'Refund queued for admin review. No automatic action taken.',
      };
    } catch (err) {
      // Release dedup key so Shopify can retry on transient failure
      await this.redis.del(dedupeKey);
      this.logger.error(`Intercept error | order=${shopifyOrdId}: ${(err as Error).message}`);
      throw err;
    }
  }

  // ── POST returns/intercept ───────────────────────────────────────────────
  // Intercepts Shopify returns/create — BLOCKS inventory reversal.

  @Post('returns/intercept')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Intercept Shopify return webhook — queues for admin review, NO auto-action' })
  async interceptReturnCreated(
    @Headers('x-shopify-hmac-sha256') hmacHeader: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @RawBody() rawBody: Buffer,
  ) {
    await this.validateHmac(rawBody, hmacHeader, shopDomain);

    const payload      = this.parseBody(rawBody);
    const shopifyRetId = String(payload.id);
    const shopifyOrdId = String(payload.order_id);
    const dedupeKey    = `returnshield:return:${shopifyRetId}`;

    const isNew = await this.redis.set(dedupeKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    if (!isNew) {
      return { status: 'already_intercepted' };
    }

    try {
      const { order, tenantId } = await this.resolveOrder(shopifyOrdId);

      if (order) {
        const dto: CreateReturnRequestDto = {
          orderId:        order.id,
          reasonCategory: ReturnReason.OTHER,
          reason:         `Shopify return initiated by customer. Return ID: ${shopifyRetId}`,
          notes:
            `Intercepted from Shopify returns/create webhook. ` +
            `Inventory reversal BLOCKED. Admin review required.`,
        };

        const result = await this.returnService.createReturnRequest({
          customerId: order.customer_id,
          tenantId,
          dto,
        });

        await this.returnAudit.logShopifyReturnIntercepted({
          tenantId,
          shopifyOrderId:  shopifyOrdId,
          topic:           'returns/create',
          returnRequestId: result.returnRequestId,
        });

        this.logger.log(
          `🛡️  RETURN INTERCEPTED | shopifyOrder=${shopifyOrdId} ` +
          `shopifyReturn=${shopifyRetId} internalReturn=${result.returnRequestId} ` +
          `autoInventory=BLOCKED`,
        );
      }

      return {
        status:        'intercepted',
        autoInventory: false,
        autoRefund:    false,
        financialState:'unchanged',
      };
    } catch (err) {
      await this.redis.del(dedupeKey);
      throw err;
    }
  }

  // ── POST orders/cancelled ────────────────────────────────────────────────
  // Intercepts Shopify orders/cancelled — BLOCKS auto-refund on cancellation.

  @Post('orders/cancelled')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Intercept Shopify order cancellation — queues for admin review' })
  async interceptOrderCancelled(
    @Headers('x-shopify-hmac-sha256') hmacHeader: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @RawBody() rawBody: Buffer,
  ) {
    await this.validateHmac(rawBody, hmacHeader, shopDomain);

    const payload      = this.parseBody(rawBody);
    const shopifyOrdId = String(payload.id);
    const dedupeKey    = `returnshield:cancel:${shopifyOrdId}`;

    const isNew = await this.redis.set(dedupeKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    if (!isNew) {
      return { status: 'already_intercepted' };
    }

    try {
      const { order, tenantId } = await this.resolveOrder(shopifyOrdId);

      if (order) {
        const dto: CreateReturnRequestDto = {
          orderId:        order.id,
          reasonCategory: ReturnReason.OTHER,
          reason:
            `Order cancelled via Shopify. Cancel reason: ` +
            `${payload.cancel_reason ?? 'customer_request'}`,
          notes:
            `Intercepted from Shopify orders/cancelled. ` +
            `Auto-refund BLOCKED. Queued for admin review.`,
        };

        const result = await this.returnService.createReturnRequest({
          customerId: order.customer_id,
          tenantId,
          dto,
        });

        await this.returnAudit.logShopifyReturnIntercepted({
          tenantId,
          shopifyOrderId:  shopifyOrdId,
          topic:           'orders/cancelled',
          returnRequestId: result.returnRequestId,
        });

        this.logger.log(
          `🛡️  CANCELLATION INTERCEPTED | shopifyOrder=${shopifyOrdId} ` +
          `internalReturn=${result.returnRequestId} autoRefund=BLOCKED`,
        );
      }

      return {
        status:         'intercepted',
        autoRefund:     false,
        financialState: 'unchanged',
        message:        'Cancellation queued for admin review. No automatic refund.',
      };
    } catch (err) {
      await this.redis.del(dedupeKey);
      throw err;
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private parseBody(rawBody: Buffer): Record<string, any> {
    try {
      return JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON payload in Shopify webhook');
    }
  }

  private async validateHmac(
    rawBody:    Buffer,
    hmacHeader: string,
    shopDomain: string,
  ): Promise<void> {
    if (!hmacHeader) {
      throw new UnauthorizedException('Missing X-Shopify-Hmac-Sha256 header');
    }
    if (!rawBody?.length) {
      throw new BadRequestException('Empty raw body — cannot validate HMAC');
    }

    // Attempt per-tenant secret first, fall back to global env secret
    let secret = this.fallbackSecret;
    if (shopDomain) {
      try {
        const creds = await this.apiKeys.getByShopDomain(shopDomain);
        if (creds?.webhookSecret) secret = creds.webhookSecret;
      } catch {
        // non-fatal — fall through to global secret
      }
    }

    if (!secret) {
      throw new UnauthorizedException(
        'SHOPIFY_WEBHOOK_SECRET not configured — cannot validate webhook',
      );
    }

    const expected    = createHmac('sha256', secret).update(rawBody).digest('base64');
    const expectedBuf = Buffer.from(expected,    'base64');
    const actualBuf   = Buffer.from(hmacHeader,  'base64');

    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      this.logger.warn(`HMAC validation failed for shop: ${shopDomain}`);
      throw new UnauthorizedException('Shopify HMAC verification failed');
    }
  }

  private async resolveOrder(shopifyOrderId: string): Promise<{
    order: { id: string; customer_id: string } | null;
    tenantId: string;
  }> {
    const res = await this.db.$client.query<{
      id: string; customer_id: string; tenant_id: string;
    }>(
      `SELECT id, customer_id, tenant_id FROM orders WHERE platform_order_id = $1 LIMIT 1`,
      [shopifyOrderId],
    );

    if (!res.rows.length) return { order: null, tenantId: 'unknown' };

    const row = res.rows[0];
    return {
      order:    { id: row.id, customer_id: row.customer_id },
      tenantId: row.tenant_id,
    };
  }
}
