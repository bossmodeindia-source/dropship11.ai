/**
 * ShopifyModule — V70 Production Certified
 *
 * V70: Full lifecycle webhook controller (10 lifecycle events)
 *   + WebhookIdempotencyService integration
 *   + OutboxService integration (all side effects via outbox)
 *   + AuditService integration (all lifecycle events audit-logged)
 */
import { Module }                      from '@nestjs/common';
import { ShopifyService }              from './shopify.service';
import { ShopifyApiKeysService }       from './shopify-api-keys.service';
import { ShopifyAutoListingService }   from './shopify-auto-listing.service';
import { ShopifyOrderSyncService }     from './shopify-order-sync.service';
import { ShopifyController }           from './shopify.controller';
import { ShopifyWebhookV60Controller }    from './shopify-webhook-v60.controller';
import { ShopifyCircuitBreaker }       from './shopify-circuit-breaker.service';
import { OrdersModule }                from '../orders/orders.module';
import { AuditModule }                 from '../audit/audit.module';
import { SupplierModule }              from '../supplier/supplier.module';
import { RedisModule }                 from '../common/redis/redis.module';
import { RedisHealthGuard }            from '../common/redis/redis-health.guard';

// WebhookModule and OutboxModule are @Global — no explicit import needed.
// DatabaseModule is @Global — no explicit import needed.

@Module({
  imports: [
    OrdersModule,
    AuditModule,
    SupplierModule,
    RedisModule,
  ],
  controllers: [
    ShopifyController,
    ShopifyWebhookV60Controller,  // V70: full 10-event lifecycle controller
  ],
  providers: [
    ShopifyService,
    ShopifyApiKeysService,
    ShopifyAutoListingService,
    ShopifyOrderSyncService,
    ShopifyCircuitBreaker,
    RedisHealthGuard,
  ],
  exports: [
    ShopifyService,
    ShopifyApiKeysService,
    ShopifyAutoListingService,
    ShopifyOrderSyncService,
    ShopifyCircuitBreaker,
  ],
})
export class ShopifyModule {}
