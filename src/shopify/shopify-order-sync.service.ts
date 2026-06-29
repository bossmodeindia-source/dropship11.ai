import { Injectable, Logger } from '@nestjs/common';

/**
 * ShopifyOrderSyncService — syncs Shopify order statuses to the local DB.
 * Handles order lifecycle transitions (pending → shipped → delivered → failed).
 */
@Injectable()
export class ShopifyOrderSyncService {
  private readonly logger = new Logger(ShopifyOrderSyncService.name);

  /**
   * No-op stub — the real sync logic runs through the unified order webhook handler.
   * This service exists for DI compatibility with ShopifyModule.
   */
  async syncOrderStatus(_orderId: string, _status: string): Promise<void> {
    this.logger.debug(`[ShopifyOrderSync] syncOrderStatus called — handled by webhook pipeline`);
  }
}
