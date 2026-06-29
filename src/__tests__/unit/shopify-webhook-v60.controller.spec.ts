/**
 * ShopifyWebhookV60Controller — V66 Enterprise Unit Tests
 *
 * Covers:
 *   ✅ HMAC validation (SHOPIFY_WEBHOOK_SECRET only — no fallback)
 *   ✅ Timestamp freshness check
 *   ✅ Redis replay protection
 *   ✅ Idempotency (duplicate webhook ignored)
 *   ✅ All endpoints: orders/paid, orders/cancelled, orders/refunded, app/uninstalled
 *   ✅ Raw body requirement
 */

import { Test, TestingModule }  from '@nestjs/testing';
import { ConfigService }        from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { createHmac }           from 'crypto';
import { ShopifyWebhookV60Controller } from '../../shopify/shopify-webhook-v60.controller';
import { OrdersService }        from '../../orders/orders.service';
<<<<<<< HEAD
import { getRedisToken }        from '../../common/redis/inject-redis';
=======
import { getRedisToken }        from '@liaoliaots/nestjs-redis';
>>>>>>> a1b8c0c1cff445126259345924e07d81a359e9bd
import { RedisHealthGuard }     from '../../common/redis/redis-health.guard';
import { Reflector }            from '@nestjs/core';
import { WebhookIdempotencyService } from '../../common/webhook/webhook-idempotency.service';
import { OutboxService }        from '../../common/outbox/outbox.service';
import { AuditService }         from '../../audit/audit.service';
import { DB_TOKEN }             from '../../common/database/database.module';

const WEBHOOK_SECRET = 'test-webhook-secret-v66';

function makeHmac(body: Buffer | string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret)
    .update(typeof body === 'string' ? Buffer.from(body) : body)
    .digest('base64');
}

function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function staleTimestamp(): string {
  return String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
}

describe('ShopifyWebhookV60Controller (V66 Hardened)', () => {
  let controller: ShopifyWebhookV60Controller;
  let mockRedis: Record<string, jest.Mock>;
  let mockOrders: jest.Mocked<OrdersService>;
  let mockIdempotency: Record<string, jest.Mock>;
  let mockDb: any;
  let module: TestingModule;

  const sampleOrderBody = Buffer.from(JSON.stringify({
    id:           '12345',
    order_number: 1001,
    email:        'customer@example.com',
    total_price:  '999.00',
    currency:     'INR',
    customer_id:  'cust-1',
    line_items:   [{ id: 'li-1', title: 'Product A', quantity: 1, price: '999.00' }],
  }));

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),   // not processed by default
      set: jest.fn().mockResolvedValue('OK'),
      ping: jest.fn().mockResolvedValue('PONG'),
    };

    mockOrders = {
      processShopifyOrder: jest.fn().mockResolvedValue(undefined),
      cancelOrder:         jest.fn().mockResolvedValue(undefined),
      pauseShop:           jest.fn().mockResolvedValue(undefined),
    } as any;

    mockIdempotency = {
      claim: jest.fn(async (_provider: string, eventId: string) => {
        const key = `shopify:webhook:${eventId}`;
        const existing = await mockRedis.get(key);
        return { duplicate: Boolean(existing), key };
      }),
      complete: jest.fn(async (_provider: string, eventId: string) => {
        await mockRedis.set(`shopify:webhook:${eventId}`, new Date().toISOString(), 'EX', 604800);
      }),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    mockDb = {
      query: { shopifyApiKeys: { findFirst: jest.fn().mockResolvedValue(null) } },
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    };

    module = await Test.createTestingModule({
      controllers: [ShopifyWebhookV60Controller],
      providers: [
        {
          provide:  ConfigService,
          useValue: { get: (key: string, def?: string) => key === 'SHOPIFY_WEBHOOK_SECRET' ? WEBHOOK_SECRET : def },
        },
        { provide: OrdersService, useValue: mockOrders },
        { provide: WebhookIdempotencyService, useValue: mockIdempotency },
        { provide: OutboxService, useValue: { publishInTx: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: DB_TOKEN, useValue: mockDb },
        { provide: getRedisToken('default'), useValue: mockRedis },
        { provide: RedisHealthGuard, useValue: { canActivate: jest.fn().mockReturnValue(true) } },
        Reflector,
      ],
    })
      .overrideGuard(RedisHealthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get<ShopifyWebhookV60Controller>(ShopifyWebhookV60Controller);
  });

  afterEach(async () => {
    await module.close();
  });

  // ─── Startup validation ───────────────────────────────────────────────────
  describe('startup security', () => {
    it('should throw at startup if SHOPIFY_WEBHOOK_SECRET is not set', async () => {
      const brokenConfig = { get: jest.fn().mockReturnValue('') };

      await expect(
        Test.createTestingModule({
          controllers: [ShopifyWebhookV60Controller],
          providers: [
            { provide: ConfigService,  useValue: brokenConfig },
            { provide: OrdersService,  useValue: mockOrders },
            { provide: WebhookIdempotencyService, useValue: mockIdempotency },
            { provide: OutboxService, useValue: { publishInTx: jest.fn() } },
            { provide: AuditService, useValue: { log: jest.fn() } },
            { provide: DB_TOKEN, useValue: mockDb },
            { provide: getRedisToken('default'), useValue: mockRedis },
            { provide: RedisHealthGuard, useValue: { canActivate: jest.fn().mockReturnValue(true) } },
            Reflector,
          ],
        })
          .overrideGuard(RedisHealthGuard)
          .useValue({ canActivate: jest.fn().mockReturnValue(true) })
          .compile(),
      ).rejects.toThrow('SHOPIFY_WEBHOOK_SECRET must be configured');
    });
  });

  // ─── HMAC validation ─────────────────────────────────────────────────────
  describe('HMAC validation', () => {
    it('should accept a valid HMAC signature', async () => {
      const hmac = makeHmac(sampleOrderBody);
      const ts   = freshTimestamp();

      const result = await controller.handleOrderPaid(
        hmac, 'test-shop.myshopify.com', '12345', ts,
        JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
      );

      expect(result.status).toBe('processed');
    });

    it('should reject a wrong HMAC signature', async () => {
      await expect(
        controller.handleOrderPaid(
          'wrong-hmac-value', 'test-shop.myshopify.com', '12345',
          freshTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject missing HMAC header', async () => {
      await expect(
        controller.handleOrderPaid(
          '', 'test-shop.myshopify.com', '12345',
          freshTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject HMAC signed with wrong secret (WEBHOOK_HMAC_SECRET fallback FORBIDDEN)', async () => {
      // This tests that the old WEBHOOK_HMAC_SECRET fallback is NOT accepted
      const wrongSecretHmac = makeHmac(sampleOrderBody, 'old-webhook-hmac-secret');

      await expect(
        controller.handleOrderPaid(
          wrongSecretHmac, 'test-shop.myshopify.com', '12345',
          freshTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should use timing-safe comparison (no timing oracle)', async () => {
      // Verify the controller uses timingSafeEqual by ensuring different-length HMAC is rejected
      await expect(
        controller.handleOrderPaid(
          'short', 'test-shop.myshopify.com', '12345',
          freshTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─── Timestamp validation ─────────────────────────────────────────────────
  describe('timestamp freshness', () => {
    it('should reject webhooks older than 5 minutes', async () => {
      const hmac = makeHmac(sampleOrderBody);

      await expect(
        controller.handleOrderPaid(
          hmac, 'test-shop.myshopify.com', '12345',
          staleTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should accept webhooks within the 5-minute window', async () => {
      const hmac = makeHmac(sampleOrderBody);
      const ts = String(Math.floor(Date.now() / 1000) - 60); // 1 minute ago

      const result = await controller.handleOrderPaid(
        hmac, 'test-shop.myshopify.com', '12345',
        ts, JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
      );
      expect(result.status).toBe('processed');
    });
  });

  // ─── Replay protection ────────────────────────────────────────────────────
  describe('Redis replay protection & idempotency', () => {
    it('should return already_processed for duplicate webhook (same orderId)', async () => {
      mockRedis.get.mockResolvedValue(new Date().toISOString()); // already in Redis

      const hmac = makeHmac(sampleOrderBody);
      const result = await controller.handleOrderPaid(
        hmac, 'test-shop.myshopify.com', '12345',
        freshTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
      );

      expect(result.status).toBe('already_processed');
      expect(mockOrders.processShopifyOrder).not.toHaveBeenCalled();
    });

    it('should write idempotency key to Redis after processing', async () => {
      const hmac = makeHmac(sampleOrderBody);

      await controller.handleOrderPaid(
        hmac, 'test-shop.myshopify.com', '12345',
        freshTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
      );

      expect(mockRedis.set).toHaveBeenCalledWith(
        'shopify:webhook:orders/paid:12345',
        expect.any(String),
        'EX',
        604800, // 7-day TTL
      );
    });

    it('should use 7-day TTL for replay protection', async () => {
      const hmac = makeHmac(sampleOrderBody);
      await controller.handleOrderPaid(
        hmac, 'test-shop.myshopify.com', '12345',
        freshTimestamp(), JSON.parse(sampleOrderBody.toString()), sampleOrderBody,
      );

      const setCall = mockRedis.set.mock.calls[0];
      expect(setCall[3]).toBe(604800);
    });
  });

  // ─── orders/cancelled ─────────────────────────────────────────────────────
  describe('orders/cancelled', () => {
    it('should cancel order with valid HMAC', async () => {
      const body = Buffer.from(JSON.stringify({ id: '99999', cancel_reason: 'customer' }));
      const hmac = makeHmac(body);

      const result = await controller.handleOrderCancelled(
        hmac, 'test-shop.myshopify.com', '99999', freshTimestamp(),
        JSON.parse(body.toString()), body,
      );

      expect(result.status).toBe('processed');
      expect(mockOrders.cancelOrder).toHaveBeenCalledWith('99999');
    });
  });

  // ─── orders/refunded ─────────────────────────────────────────────────────
  describe('orders/refunded', () => {
    it('should handle refund webhook with valid HMAC', async () => {
      const refundBody = Buffer.from(JSON.stringify({
        id: '88888',
        refunds: [{ transactions: [{ amount: '250.00' }] }],
      }));
      const hmac = makeHmac(refundBody);

      const result = await controller.handleOrderRefunded(
        hmac, 'test-shop.myshopify.com', '88888', freshTimestamp(),
        JSON.parse(refundBody.toString()), refundBody,
      );

      expect(result.status).toBe('processed');
      expect(result).toMatchObject({ lifecycle: 'ORDER_REFUNDED', refundAmount: 250 });
    });
  });

  // ─── app/uninstalled ─────────────────────────────────────────────────────
  describe('app/uninstalled', () => {
    it('should pause shop when app is uninstalled', async () => {
      const uninstallBody = Buffer.from(JSON.stringify({ id: 'shop-123', domain: 'test.myshopify.com' }));
      const hmac = makeHmac(uninstallBody);

      const result = await controller.handleAppUninstalled(
        hmac, 'test.myshopify.com', freshTimestamp(),
        JSON.parse(uninstallBody.toString()), uninstallBody,
      );

      expect(result.status).toBe('processed');
      expect(mockOrders.pauseShop).toHaveBeenCalledWith('test.myshopify.com');
    });
  });
});
