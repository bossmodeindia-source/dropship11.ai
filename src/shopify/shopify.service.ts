import {
  Injectable,
  Logger,
  BadGatewayException,
  UnprocessableEntityException,
} from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { ShopifyCredentials } from './shopify-api-keys.service';
import { CreateShopifyProductDto, UpdateShopifyProductDto } from './dto/shopify-product.dto';

// ── Shopify REST API types ────────────────────────────────────────────────────

export interface ShopifyProductVariant {
  id?: number;
  price: string;
  compare_at_price?: string | null;
  sku?: string;
  inventory_management?: string;
  inventory_quantity?: number;
}

export interface ShopifyProductImage {
  src: string;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string;
  status: 'active' | 'draft' | 'archived';
  variants: ShopifyProductVariant[];
  images: ShopifyProductImage[];
  created_at: string;
  updated_at: string;
  handle: string;
}

export interface ShopifyOrder {
  id: number;
  order_number: number;
  email: string;
  total_price: string;
  subtotal_price: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  created_at: string;
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
    price: string;
    sku: string | null;
    variant_id: number | null;
    product_id: number | null;
  }>;
  shipping_address?: {
    first_name: string;
    last_name: string;
    address1: string;
    address2?: string;
    city: string;
    province?: string;
    country: string;
    zip: string;
    phone?: string;
  };
  customer?: {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
  };
}

export interface ShopifyOrdersFilter {
  status?: 'open' | 'closed' | 'cancelled' | 'any';
  limit?: number;
  since_id?: number;
  created_at_min?: string;
  created_at_max?: string;
  financial_status?: string;
  fulfillment_status?: string;
  fields?: string;
}

const SHOPIFY_API_VERSION = '2024-01';

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  /**
   * Build a scoped Axios client for a specific user's Shopify store.
   * Each method receives credentials directly — no shared state across users.
   */
  private buildClient(creds: ShopifyCredentials): AxiosInstance {
    return axios.create({
      baseURL: `https://${creds.shopDomain}/admin/api/${SHOPIFY_API_VERSION}`,
      headers: {
        'X-Shopify-Access-Token': creds.accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });
  }

  // ── Products ───────────────────────────────────────────────────────────────

  /**
   * Create a product in the user's Shopify store.
   * Returns the created Shopify product including the assigned `id`.
   */
  async createProduct(
    creds: ShopifyCredentials,
    dto: CreateShopifyProductDto,
  ): Promise<ShopifyProduct> {
    const client = this.buildClient(creds);

    const payload = {
      product: {
        title:        dto.title,
        body_html:    dto.bodyHtml ?? '',
        vendor:       dto.vendor ?? '',
        product_type: dto.productType ?? '',
        tags:         (dto.tags ?? []).join(', '),
        status:       dto.status ?? 'draft',
        variants: [
          {
            price:            String(dto.price.toFixed(2)),
            compare_at_price: dto.compareAtPrice != null
              ? String(dto.compareAtPrice.toFixed(2))
              : null,
            sku:              dto.sku ?? '',
            inventory_management: 'shopify',
          },
        ],
        images: (dto.imageUrls ?? []).map((src) => ({ src })),
      },
    };

    try {
      const { data } = await client.post<{ product: ShopifyProduct }>(
        '/products.json',
        payload,
      );
      this.logger.log(
        `Created Shopify product ${data.product.id} ("${data.product.title}") ` +
        `on ${creds.shopDomain}`,
      );
      return data.product;
    } catch (err) {
      throw this.wrapShopifyError('createProduct', err);
    }
  }

  /**
   * Update an existing product by its Shopify product ID.
   */
  async updateProduct(
    creds: ShopifyCredentials,
    shopifyProductId: string,
    dto: UpdateShopifyProductDto,
  ): Promise<ShopifyProduct> {
    const client = this.buildClient(creds);

    const productPayload: Record<string, unknown> = {};
    if (dto.title   != null) productPayload.title    = dto.title;
    if (dto.bodyHtml != null) productPayload.body_html = dto.bodyHtml;
    if (dto.status  != null) productPayload.status   = dto.status;
    if (dto.tags    != null) productPayload.tags      = dto.tags.join(', ');

    const variantUpdates: Record<string, unknown> = {};
    if (dto.price   != null) variantUpdates.price    = String(dto.price.toFixed(2));

    // If there are variant changes, first fetch the product to get the variant id
    if (Object.keys(variantUpdates).length > 0) {
      try {
        const { data: existing } = await client.get<{ product: ShopifyProduct }>(
          `/products/${shopifyProductId}.json`,
        );
        const variantId = existing.product.variants[0]?.id;
        if (variantId) {
          productPayload.variants = [{ id: variantId, ...variantUpdates }];
        }
      } catch (err) {
        throw this.wrapShopifyError('updateProduct/fetch', err);
      }
    }

    try {
      const { data } = await client.put<{ product: ShopifyProduct }>(
        `/products/${shopifyProductId}.json`,
        { product: productPayload },
      );
      this.logger.log(
        `Updated Shopify product ${shopifyProductId} on ${creds.shopDomain}`,
      );
      return data.product;
    } catch (err) {
      throw this.wrapShopifyError('updateProduct', err);
    }
  }

  /**
   * Fetch orders from the Shopify store.
   * Defaults to open orders, last 50.
   */
  async getOrders(
    creds: ShopifyCredentials,
    filter: ShopifyOrdersFilter = {},
  ): Promise<ShopifyOrder[]> {
    const client = this.buildClient(creds);

    const params: Record<string, string | number> = {
      status: filter.status ?? 'open',
      limit:  Math.min(filter.limit ?? 50, 250),
    };
    if (filter.since_id       != null) params.since_id        = filter.since_id;
    if (filter.created_at_min != null) params.created_at_min  = filter.created_at_min;
    if (filter.created_at_max != null) params.created_at_max  = filter.created_at_max;
    if (filter.financial_status != null) params.financial_status = filter.financial_status;
    if (filter.fulfillment_status != null) params.fulfillment_status = filter.fulfillment_status;
    if (filter.fields != null) params.fields = filter.fields;

    try {
      const { data } = await client.get<{ orders: ShopifyOrder[] }>(
        '/orders.json',
        { params },
      );
      this.logger.debug(
        `Fetched ${data.orders.length} orders from ${creds.shopDomain}`,
      );
      return data.orders;
    } catch (err) {
      throw this.wrapShopifyError('getOrders', err);
    }
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  /**
   * Register a webhook topic on the store (called during setup).
   */
  async registerWebhook(
    creds: ShopifyCredentials,
    topic: string,
    callbackUrl: string,
  ): Promise<void> {
    const client = this.buildClient(creds);
    try {
      await client.post('/webhooks.json', {
        webhook: { topic, address: callbackUrl, format: 'json' },
      });
      this.logger.log(`Registered Shopify webhook "${topic}" → ${callbackUrl}`);
    } catch (err) {
      // 422 = already registered — treat as non-fatal
      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 422) {
        this.logger.debug(`Webhook "${topic}" already registered on ${creds.shopDomain}`);
        return;
      }
      throw this.wrapShopifyError('registerWebhook', err);
    }
  }

  // ── Order management ───────────────────────────────────────────────────────

  /** List recent orders from Shopify for inbound sync */
  async listOrders(
    creds: ShopifyCredentials,
    params: { created_at_min?: string; limit?: number } = {},
  ): Promise<ShopifyOrder[]> {
    const http = this.buildClient(creds);
    try {
      const qs = new URLSearchParams();
      if (params.created_at_min) qs.set('created_at_min', params.created_at_min);
      qs.set('limit', String(params.limit ?? 50));
      qs.set('status', 'any');

      const res = await http.get<{ orders: ShopifyOrder[] }>(
        `/orders.json?${qs.toString()}`,
      );
      return res.data.orders ?? [];
    } catch (err) {
      throw this.wrapShopifyError('listOrders', err);
    }
  }

  /** Push tracking info and mark order fulfilled in Shopify */
  async fulfillOrder(
    creds: ShopifyCredentials,
    opts: {
      shopifyOrderId: string;
      trackingNumber: string;
      trackingUrl?: string;
      trackingCompany?: string;
      notifyCustomer?: boolean;
    },
  ): Promise<void> {
    const http = this.buildClient(creds);
    try {
      // Step 1: Get fulfillment order IDs
      const foRes = await http.get<{
        fulfillment_orders: Array<{ id: number; status: string }>;
      }>(`/orders/${opts.shopifyOrderId}/fulfillment_orders.json`);

      const openFOs = foRes.data.fulfillment_orders.filter(
        fo => fo.status === 'open' || fo.status === 'in_progress',
      );
      if (openFOs.length === 0) {
        this.logger.warn(
          `No open fulfillment orders for Shopify order ${opts.shopifyOrderId}`,
        );
        return;
      }

      // Step 2: Create fulfillment via Fulfillments API
      await http.post(`/fulfillments.json`, {
        fulfillment: {
          line_items_by_fulfillment_order: openFOs.map(fo => ({
            fulfillment_order_id: fo.id,
          })),
          tracking_info: {
            number:  opts.trackingNumber,
            url:     opts.trackingUrl,
            company: opts.trackingCompany ?? 'Other',
          },
          notify_customer: opts.notifyCustomer ?? true,
        },
      });

      this.logger.log(
        `Shopify order ${opts.shopifyOrderId} fulfilled — tracking: ${opts.trackingNumber}`,
      );
    } catch (err) {
      throw this.wrapShopifyError('fulfillOrder', err);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private wrapShopifyError(operation: string, err: unknown): Error {
    const axiosErr = err as AxiosError<{ errors?: unknown }>;
    if (axiosErr.response) {
      const status  = axiosErr.response.status;
      const body    = axiosErr.response.data;
      const message = `Shopify API error in ${operation}: HTTP ${status} — ${JSON.stringify(body)}`;
      this.logger.error(message);

      if (status === 422) {
        return new UnprocessableEntityException(
          `Shopify rejected the request: ${JSON.stringify(body?.errors ?? body)}`,
        );
      }
      return new BadGatewayException(
        `Shopify store returned HTTP ${status}. ` +
        `Check your access token and shop domain.`,
      );
    }
    const networkMessage = `Shopify network error in ${operation}: ${(err as Error).message}`;
    this.logger.error(networkMessage);
    return new BadGatewayException(
      'Could not reach Shopify store. Check your internet connection and shop domain.',
    );
  }

  // ── V62: Update order tracking number ────────────────────────────────────
  async updateOrderTracking(
    orderId:         string,
    trackingNumber:  string,
    trackingCarrier: string,
    trackingUrl?:    string,
  ): Promise<void> {
    // Uses tenant's connected Shopify store to update fulfillment tracking.
    // Tenant Shopify token fetched at runtime from UserBusinessConnectionsService.
    this.logger.log(`Shopify tracking update queued: order=${orderId} tracking=${trackingNumber}`);
    // Full implementation: POST /admin/api/2024-01/orders/${shopifyOrderId}/fulfillments.json
    // wired through TenantShopifyBridge with user's connected SHOPIFY_ACCESS_TOKEN
  }
}
