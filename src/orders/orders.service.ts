import { Injectable, NotFoundException, Inject, Logger } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { IdempotencyService } from './idempotency.service';
import { OrderQueueService } from './order-queue.service';
import { AuditService } from '../audit/audit.service';
import { WebhookOrderDto } from './dto/webhook-order.dto';

/** Shopify-specific order payload — mapped to WebhookOrderDto before persistence */
export interface ShopifyWebhookPayload {
  shopifyOrderId: string;
  shopDomain?: string;
  orderNumber: number | string;
  userId: string;
  totalPrice: number;
  subtotalPrice?: number;
  currency: string;
  financialStatus?: string;
  campaignId?: string | null;
  adsetId?: string | null;
  adId?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  email?: string | null;
  customerName?: string | null;
  shippingAddress?: Record<string, unknown> | null;
  lineItems?: Array<{
    shopifyLineItemId: string;
    title: string;
    quantity: number;
    price: number;
    sku?: string | null;
    shopifyProductId?: string | null;
  }>;
  source?: string;
  webhookAt?: Date;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly idempotency: IdempotencyService,
    private readonly queue: OrderQueueService,
    private readonly audit: AuditService,
  ) {}

  async handleWebhook(
    userId: string,
    dto: WebhookOrderDto,
    ipAddress?: string,
  ): Promise<{ orderId: string; jobId: string; status: string }> {
    const idempotencyKey = dto.idempotencyKey ?? `${dto.platform}:${dto.platformOrderId}`;

    await this.idempotency.guardOrThrow(idempotencyKey);

    let orderId: string;
    let jobId: string;

    try {
      const [order] = await this.db
        .insert(schema.orders)
        .values({
          userId,
          productId: dto.productId ?? null,
          idempotencyKey,
          platformOrderId: dto.platformOrderId,
          platform: dto.platform ?? 'shopify',
          customerName: dto.customer?.name,
          customerEmail: dto.customer?.email,
          shippingAddress: dto.shippingAddress ?? {},
          quantity: dto.quantity ?? 1,
          unitPrice: String(dto.unitPrice),
          totalAmount: String(dto.totalAmount),
          currency: dto.currency ?? 'USD',
          supplierType: dto.supplierType ?? 'mock',
          rawPayload: dto as unknown as Record<string, unknown>,
          status: 'received',
        })
        .returning({ id: schema.orders.id });

      orderId = order.id;

      await this.db.insert(schema.orderStatusLog).values({
        orderId,
        fromStatus: null,
        toStatus: 'received',
        metadata: { source: 'webhook', ipAddress },
      });

      jobId = await this.queue.enqueueOrder({
        orderId,
        userId,
        platformOrderId: dto.platformOrderId,
        supplierType: dto.supplierType ?? 'mock',
        retryCount: 0,
      });

      await this.db.update(schema.orders).set({ status: 'queued' }).where(eq(schema.orders.id, orderId));
      await this.idempotency.complete(idempotencyKey, orderId);

      await this.audit.log({
      tenantId: 'system',
        actorId: userId,
        action: 'order.received',
        resource: 'orders',
        severity: 'info' as const,
        ipAddress,
      });

      this.logger.log(`Order ${orderId} received and queued (job ${jobId})`);
      return { orderId, jobId, status: 'queued' };
    } catch (err) {
      await this.idempotency.release(idempotencyKey);
      throw err;
    }
  }

  async findAll(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const [items, countResult] = await Promise.all([
      this.db.query.orders.findMany({
        where: eq(schema.orders.userId, userId),
        orderBy: [desc(schema.orders.createdAt)],
        limit,
        offset,
      }),
      this.db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(schema.orders)
        .where(eq(schema.orders.userId, userId)),
    ]);
    const total = countResult[0]?.count ?? 0;
    return {
      items,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  async findOne(userId: string, orderId: string) {
    const order = await this.db.query.orders.findFirst({
      where: and(eq(schema.orders.id, orderId), eq(schema.orders.userId, userId)),
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async getStatusLog(userId: string, orderId: string) {
    await this.findOne(userId, orderId);
    return this.db.query.orderStatusLog.findMany({
      where: eq(schema.orderStatusLog.orderId, orderId),
      orderBy: [desc(schema.orderStatusLog.createdAt)],
    });
  }

  async transitionStatus(
    orderId: string,
    from: string,
    to: typeof schema.orders.$inferSelect['status'],
    extra: Partial<typeof schema.orders.$inferInsert> = {},
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(schema.orders)
        .set({ status: to, updatedAt: new Date(), ...extra })
        .where(eq(schema.orders.id, orderId));
      await tx.insert(schema.orderStatusLog).values({
        orderId,
        fromStatus: from as typeof schema.orders.$inferSelect['status'],
        toStatus: to,
        metadata: extra as Record<string, unknown>,
      });
    });
  }

  async getQueueStats() {
    return this.queue.getQueueDepth();
  }
  /**
   * Maps a Shopify webhook payload to the generic WebhookOrderDto and persists
   * the order. This is the ONLY entry point for Shopify-originated orders.
   *
   * FIX #9: The previous implementation used a union-type overload
   * (payloadOrUserId: Record<string,unknown> | string) with multiple `as any`
   * casts, silently passing malformed data to handleWebhook(). Replaced with
   * a single, explicitly typed signature and a clear field mapping.
   */
  async createFromShopifyWebhook(payload: ShopifyWebhookPayload): Promise<void> {
    const firstItem = payload.lineItems?.[0];
    const dto: WebhookOrderDto = {
      platformOrderId: payload.shopifyOrderId,
      platform:        'shopify',
      idempotencyKey:  `shopify:${payload.shopifyOrderId}`,
      customer: {
        name:  payload.customerName ?? undefined,
        email: payload.email ?? undefined,
      },
      shippingAddress: (payload.shippingAddress as Record<string, unknown>) ?? {},
      quantity:    firstItem?.quantity ?? 1,
      unitPrice:   firstItem?.price ?? 0,
      totalAmount: payload.totalPrice,
      currency:    payload.currency,
      supplierType: 'shopify',
    };
    await this.handleWebhook(payload.userId, dto);
  }

// ── V60 webhook aliases ────────────────────────────────────────────────────
  async processShopifyOrder(payload: ShopifyWebhookPayload): Promise<void> {
    return this.createFromShopifyWebhook(payload);
  }
  async cancelOrder(orderId: string, reason?: string): Promise<void> {
    await this.transitionStatus(orderId, 'processing', 'failed');
  }
  async pauseShop(_shopDomain: string): Promise<void> {
    this.logger.warn(`pauseShop called — no-op in V60 (handled by SystemModeService)`);
  }
}
