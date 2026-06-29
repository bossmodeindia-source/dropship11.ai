import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { ShopifyService } from './shopify.service';
import { ShopifyApiKeysService } from './shopify-api-keys.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ShopifyAutoListingService {
  private readonly logger = new Logger(ShopifyAutoListingService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly shopify: ShopifyService,
    private readonly apiKeys: ShopifyApiKeysService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Called after scoreAndDecide() when decision === 'RUN_ADS'.
   * Fetches user's Shopify credentials, creates the product in their store,
   * then persists the Shopify product ID back to the local product row.
   *
   * Failures are logged and swallowed — scoring must never fail due to
   * Shopify being down or misconfigured.
   */
  async autoListIfEligible(
    userId: string,
    product: typeof schema.products.$inferSelect,
  ): Promise<void> {
    if (product.decision !== 'RUN_ADS') return;

    // Skip if already listed in Shopify
    if (product.shopifyProductId) {
      this.logger.debug(
        `Product ${product.id} already has shopifyProductId ${product.shopifyProductId} — skipping auto-list`,
      );
      return;
    }

    try {
      await this.doList(userId, product);
    } catch (err) {
      // Non-fatal: log and continue — product scoring result is already persisted
      this.logger.error(
        `Auto-listing failed for product ${product.id} (user ${userId}): ` +
        `${(err as Error).message}`,
      );
    }
  }

  private async doList(
    userId: string,
    product: typeof schema.products.$inferSelect,
  ): Promise<void> {
    // Credentials check: no credentials → skip silently
    let creds;
    try {
      creds = await this.apiKeys.getForUser(userId);
    } catch {
      this.logger.debug(
        `User ${userId} has no Shopify credentials — skipping auto-list for product ${product.id}`,
      );
      return;
    }

    const sellingPrice = product.sellingPrice
      ? parseFloat(product.sellingPrice)
      : parseFloat(product.supplierPrice) * 2.5;

    const shopifyProduct = await this.shopify.createProduct(creds, {
      title:       product.title,
      bodyHtml:    product.description ?? '',
      productType: product.category ?? '',
      tags:        product.tags ?? [],
      status:      'active',
      price:       sellingPrice,
      imageUrls:   product.imageUrls ?? [],
      sku:         product.externalId ?? undefined,
    });

    // Persist Shopify product ID + update status to 'listed'
    await this.db
      .update(schema.products)
      .set({
        shopifyProductId: String(shopifyProduct.id),
        status:           'listed',
        listedAt:         new Date(),
      })
      .where(eq(schema.products.id, product.id));

    await this.audit.log({
      tenantId: 'system',
      actorId:  userId,
      action:   'product.listed',
      resource: 'products',
      resourceId: product.id,
      severity: 'info',
      details: {
        shopifyProductId: shopifyProduct.id,
        shopDomain:       creds.shopDomain,
        status:           'listed',
      },
    });

    this.logger.log(
      `Auto-listed product ${product.id} → Shopify product ${shopifyProduct.id} ` +
      `on ${creds.shopDomain}`,
    );
  }


  /** Alias used by CommercePipelineService */
  async listProduct(productId: string, userId: string): Promise<void> {
    await this.autoListIfEligible(userId, { id: productId } as typeof schema.products.$inferSelect);
  }
}
