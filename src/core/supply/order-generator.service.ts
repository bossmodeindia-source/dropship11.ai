/**
 * OrderGeneratorService — V51
 *
 * Generates and persists supplier order records.
 *
 * Map: product → supplier → customer (from Shopify orders)
 *
 * Order starts in status = PENDING_REVIEW.
 * Admin confirms → CONFIRMED.
 * Admin pays manually → PAID → ready to ship.
 *
 * SAFETY:
 *   - NO auto-payment.
 *   - NO external API call at generation time.
 *   - Insert only to supplier_orders table.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SelectedSupplier } from './supplier-selector.service';
import { DeliveryPredictorService } from './delivery-predictor.service';

export type OrderStatus =
  | 'PENDING_REVIEW'
  | 'CONFIRMED'
  | 'PAID'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED';

export interface SupplierOrderRecord {
  id:               string;
  product_id:       string;
  supplier:         string;
  supplier_id:      string;
  customer_details: CustomerDetails;
  cost:             number;
  status:           OrderStatus;
  tracking_id:      string | null;
  delivery_estimate: string | null;
  delay_probability: number | null;
  created_at:        string;
}

export interface CustomerDetails {
  name?:    string;
  email?:   string;
  phone?:   string;
  address?: string;
  city?:    string;
  pincode?: string;
  country?: string;
}

export interface GeneratedOrder {
  id:           string;
  productId:    string;
  supplier:     string;
  cost:         number;
  customerCity: string;
  status:       OrderStatus;
}

@Injectable()
export class OrderGeneratorService {
  private readonly logger = new Logger(OrderGeneratorService.name);

  constructor(
    private readonly pool:              Pool,
    private readonly deliveryPredictor: DeliveryPredictorService,
  ) {}

  // ── Public ────────────────────────────────────────────────────────────────

  async generateOrder(
    product:          { product_id?: string; name?: string; price_usd?: number },
    selected:         SelectedSupplier,
    customerDetails?: CustomerDetails,
  ): Promise<GeneratedOrder | null> {
    const productId = product.product_id ?? `prod_${uuidv4().slice(0, 8)}`;
    const supplier  = selected.supplier;

    // Estimate cost (supplier avg or product price as fallback)
    const cost = supplier.avg_cost_inr ?? Math.round((product.price_usd ?? 10) * 83);

    // Delivery prediction
    const delivery = this.deliveryPredictor.predict(supplier);

    // Resolve customer details (may come from pending Shopify order)
    const customer = customerDetails ?? await this.loadPendingCustomer(productId);

    const id = `order_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    try {
      await this.pool.query(
        `INSERT INTO supplier_orders
           (id, product_id, supplier, supplier_id, customer_details, cost,
            status, tracking_id, delivery_estimate, delay_probability, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING_REVIEW',NULL,$7,$8,NOW())`,
        [
          id,
          productId,
          supplier.name,
          supplier.id,
          JSON.stringify(customer),
          cost,
          delivery.estimatedDateISO,
          delivery.delayProbability,
        ],
      );

      this.logger.log(
        `Order ${id} generated — supplier: ${supplier.name}, cost: ₹${cost}, ` +
        `ETA: ${delivery.estimatedDateISO}`,
      );

      return {
        id,
        productId,
        supplier:     supplier.name,
        cost,
        customerCity: customer?.city ?? 'Unknown',
        status:       'PENDING_REVIEW',
      };
    } catch (err) {
      this.logger.error(`Order generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async loadPendingCustomer(productId: string): Promise<CustomerDetails> {
    try {
      const { rows } = await this.pool.query(
        `SELECT shipping_address
         FROM orders
         WHERE line_items::text ILIKE $1
           AND fulfillment_status IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [`%${productId}%`],
      );
      if (rows[0]?.shipping_address) {
        const addr = rows[0].shipping_address;
        return {
          name:    addr.name,
          address: addr.address1,
          city:    addr.city,
          pincode: addr.zip,
          country: addr.country_code ?? 'IN',
        };
      }
    } catch {
      // No matching order — order without customer detail
    }
    return { city: 'Unknown', country: 'IN' };
  }
}
