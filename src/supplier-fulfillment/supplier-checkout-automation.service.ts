/**
 * SupplierCheckoutAutomationService
 *
 * Builds supplier-specific checkout URLs with prefilled parameters.
 * When admin clicks "PROCESS SUPPLIER ORDER", this service:
 *   1. Builds a checkout URL for the specific supplier
 *   2. Embeds autofill metadata (customer details, quantity, variant)
 *   3. Creates a checkout session record (expires 2h)
 *   4. Returns the URL for admin redirect
 *
 * Supported:
 *   - AliExpress    (cart prefill + affiliate link)
 *   - CJ Dropshipping (API-based checkout initiation)
 *   - Zendrop      (URL-based with order params)
 *   - AutoDS       (URL redirect with prefill)
 *   - Alibaba      (RFQ + cart URL)
 *   - Custom        (raw URL with query params)
 */

import {
  Injectable, Logger, Inject, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import {
  supplierFulfillmentTasks,
  supplierCheckoutSessions,
} from '../escrow/escrow-schema';
import { AuditService } from '../audit/audit.service';

export type SupplierCheckoutPlatform =
  | 'aliexpress'
  | 'cjdropshipping'
  | 'zendrop'
  | 'autods'
  | 'alibaba'
  | 'custom';

export interface CheckoutSessionResult {
  sessionId:   string;
  checkoutUrl: string;
  autofillData: Record<string, unknown>;
  expiresAt:   Date;
  supplier:    SupplierCheckoutPlatform;
}

@Injectable()
export class SupplierCheckoutAutomationService {
  private readonly logger = new Logger(SupplierCheckoutAutomationService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db:   DrizzleDB,
    private readonly audit: AuditService,
  ) {}

  // ── Main entry: build checkout session for admin ───────────────────────────

  async buildCheckoutSession(
    fulfillmentId: string,
    adminId:       string,
  ): Promise<CheckoutSessionResult> {
    const rows = await this.db
      .select()
      .from(supplierFulfillmentTasks)
      .where(eq(supplierFulfillmentTasks.id, fulfillmentId))
      .limit(1);

    if (!rows.length) throw new NotFoundException(`Fulfillment task ${fulfillmentId} not found`);
    const task = rows[0];

    if (!task.supplierProductUrl) {
      throw new BadRequestException(`Fulfillment task ${fulfillmentId} has no supplier product URL`);
    }

    const supplier = task.supplier as SupplierCheckoutPlatform;
    const autofill = task.checkoutAutofill as Record<string, unknown>;
    const checkoutUrl = this.buildUrl(supplier, task.supplierProductUrl, autofill, task.quantity);

    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    const [session] = await this.db
      .insert(supplierCheckoutSessions)
      .values({
        fulfillmentId,
        supplier,
        checkoutUrl,
        autofillData:  autofill,
        openedByAdmin: adminId,
        openedAt:      new Date(),
        expiresAt,
      })
      .returning({ id: supplierCheckoutSessions.id });

    // Mark task status as checkout opened
    await this.db
      .update(supplierFulfillmentTasks)
      .set({ status: 'CHECKOUT_OPENED', processedByAdmin: adminId, processedAt: new Date() })
      .where(eq(supplierFulfillmentTasks.id, fulfillmentId));

    await this.audit.log({
      action:     'supplier_checkout.session_opened',
      resourceId: fulfillmentId,
      userId:     adminId,
      metadata:   { supplier, sessionId: session.id },
    } as any);

    this.logger.log(`Checkout session ${session.id} opened for fulfillment ${fulfillmentId} on ${supplier}`);

    return {
      sessionId:   session.id,
      checkoutUrl,
      autofillData: autofill,
      expiresAt,
      supplier,
    };
  }

  // ── Supplier-specific URL builders ────────────────────────────────────────

  private buildUrl(
    supplier:    SupplierCheckoutPlatform,
    productUrl:  string,
    autofill:    Record<string, unknown>,
    quantity:    number,
  ): string {
    switch (supplier) {
      case 'aliexpress':
        return this.buildAliExpressUrl(productUrl, autofill, quantity);
      case 'cjdropshipping':
        return this.buildCJUrl(productUrl, autofill, quantity);
      case 'zendrop':
        return this.buildZendropUrl(productUrl, autofill, quantity);
      case 'autods':
        return this.buildAutodsUrl(productUrl, autofill, quantity);
      case 'alibaba':
        return this.buildAlibabaUrl(productUrl, autofill, quantity);
      default:
        return this.buildCustomUrl(productUrl, autofill, quantity);
    }
  }

  private buildAliExpressUrl(
    productUrl: string,
    autofill:   Record<string, unknown>,
    quantity:   number,
  ): string {
    // AliExpress supports quantity via URL param for direct buy
    const base = productUrl.split('?')[0];
    const itemId = this.extractAliExpressItemId(productUrl);
    const variantId = autofill.variantId as string | undefined;

    const params = new URLSearchParams({
      quantity:    String(quantity),
      ...(itemId    ? { itemId }            : {}),
      ...(variantId ? { skuId: variantId }  : {}),
    });

    return `https://www.aliexpress.com/item/${itemId}.html?${params.toString()}`;
  }

  private buildCJUrl(
    productUrl: string,
    autofill:   Record<string, unknown>,
    quantity:   number,
  ): string {
    // CJ Dropshipping — platform API-driven; redirect to order page with prefill
    const params = new URLSearchParams({
      productUrl: encodeURIComponent(productUrl),
      quantity:   String(quantity),
      name:       String(autofill.shippingName ?? ''),
      email:      String(autofill.shippingEmail ?? ''),
    });
    return `https://app.cjdropshipping.com/product-add-to-cart?${params.toString()}`;
  }

  private buildZendropUrl(
    productUrl: string,
    autofill:   Record<string, unknown>,
    quantity:   number,
  ): string {
    const params = new URLSearchParams({
      source:   productUrl,
      qty:      String(quantity),
      shipping_name:  String(autofill.shippingName ?? ''),
      shipping_email: String(autofill.shippingEmail ?? ''),
    });
    return `https://app.zendrop.com/source?${params.toString()}`;
  }

  private buildAutodsUrl(
    productUrl: string,
    autofill:   Record<string, unknown>,
    quantity:   number,
  ): string {
    const params = new URLSearchParams({
      productUrl: encodeURIComponent(productUrl),
      quantity:   String(quantity),
    });
    return `https://app.autods.com/single-product/add?${params.toString()}`;
  }

  private buildAlibabaUrl(
    productUrl: string,
    autofill:   Record<string, unknown>,
    quantity:   number,
  ): string {
    const params = new URLSearchParams({
      quantity: String(quantity),
      name:     String(autofill.shippingName ?? ''),
    });
    return `${productUrl}${productUrl.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  private buildCustomUrl(
    productUrl: string,
    autofill:   Record<string, unknown>,
    quantity:   number,
  ): string {
    const params = new URLSearchParams({
      qty:    String(quantity),
      name:   String(autofill.shippingName ?? ''),
      email:  String(autofill.shippingEmail ?? ''),
    });
    return `${productUrl}${productUrl.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  private extractAliExpressItemId(url: string): string {
    const match = url.match(/item\/(\d+)/);
    return match ? match[1] : '';
  }

  // ── Retrieve active checkout session ──────────────────────────────────────

  async getActiveSession(fulfillmentId: string): Promise<CheckoutSessionResult | null> {
    const rows = await this.db
      .select()
      .from(supplierCheckoutSessions)
      .where(eq(supplierCheckoutSessions.fulfillmentId, fulfillmentId))
      .orderBy(supplierCheckoutSessions.createdAt)
      .limit(1);

    if (!rows.length || rows[0].expiresAt < new Date()) return null;

    const r = rows[0];
    return {
      sessionId:   r.id,
      checkoutUrl: r.checkoutUrl,
      autofillData: r.autofillData as Record<string, unknown>,
      expiresAt:   r.expiresAt,
      supplier:    r.supplier as SupplierCheckoutPlatform,
    };
  }
}
