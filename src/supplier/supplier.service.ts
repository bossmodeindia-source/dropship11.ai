import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import CircuitBreaker from 'opossum';

const ImportedCircuitBreaker =
  (CircuitBreaker as unknown as { default?: typeof CircuitBreaker } | undefined)?.default ?? CircuitBreaker;

const CircuitBreakerCtor = typeof ImportedCircuitBreaker === 'function'
  ? ImportedCircuitBreaker
  : class {
      constructor(private readonly fn: (req: SupplierOrderRequest) => Promise<SupplierOrderResponse>) {}
      on(): this { return this; }
      fire(req: SupplierOrderRequest): Promise<SupplierOrderResponse> { return this.fn(req); }
    };

export interface SupplierOrderRequest {
  platformOrderId: string;
  supplierType: string;
  items: Array<{
    externalId?: string;
    title: string;
    quantity: number;
    unitPrice: number;
  }>;
  shippingAddress: Record<string, unknown>;
  currency?: string;
}

export interface SupplierOrderResponse {
  supplierOrderId: string;
  status: string;
  estimatedShipDate?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

export interface SupplierTrackingResponse {
  supplierOrderId: string;
  trackingNumber: string;
  trackingUrl: string;
  status: string;
  shipped: boolean;
  delivered: boolean;
  estimatedDelivery?: string;
}

@Injectable()
export class SupplierService {
  private readonly logger = new Logger(SupplierService.name);
  private readonly http: AxiosInstance;
  private readonly breaker: InstanceType<typeof CircuitBreakerCtor>;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.config.get('SUPPLIER_API_URL', 'https://mock-supplier.internal/api'),
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Circuit breaker: opens after 5 consecutive failures, resets after 30s
    this.breaker = new CircuitBreakerCtor(
      (req: SupplierOrderRequest) => this.callSupplierApi(req),
      {
        timeout: 10_000,
        errorThresholdPercentage: 50,
        resetTimeout: 30_000,
        volumeThreshold: 5,
        name: 'supplier-api',
      },
    );

    this.breaker.on('open', () =>
      this.logger.error('Supplier circuit breaker OPENED — supplier API unreachable'),
    );
    this.breaker.on('halfOpen', () =>
      this.logger.warn('Supplier circuit breaker HALF-OPEN — testing'),
    );
    this.breaker.on('close', () =>
      this.logger.log('Supplier circuit breaker CLOSED — supplier API recovered'),
    );
  }

  async placeOrder(req: SupplierOrderRequest): Promise<SupplierOrderResponse> {
    try {
      return await this.breaker.fire(req) as SupplierOrderResponse;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Breaker is open')) {
        throw new ServiceUnavailableException('Supplier API circuit breaker open — retry later');
      }
      throw err;
    }
  }

  async trackOrder(supplierOrderId: string, supplierType: string): Promise<SupplierTrackingResponse> {
    // Mock: always return a shipped status in dev
    this.logger.debug(`Tracking ${supplierOrderId} via ${supplierType}`);
    return this.mockTracking(supplierOrderId);
  }

  // ── Private ──────────────────────────────────────────────────────

  private async callSupplierApi(req: SupplierOrderRequest): Promise<SupplierOrderResponse> {
    const isDev = this.config.get('NODE_ENV') !== 'production';
    if (isDev) {
      // Mock response in non-production
      return this.mockPlaceOrder(req);
    }

    const { data } = await this.http.post<SupplierOrderResponse>('/orders', {
      external_order_id: req.platformOrderId,
      supplier: req.supplierType,
      line_items: req.items.map((i) => ({
        sku: i.externalId,
        name: i.title,
        qty: i.quantity,
        unit_price: i.unitPrice,
      })),
      shipping: req.shippingAddress,
      currency: req.currency ?? 'USD',
    });

    return data;
  }

  private mockPlaceOrder(req: SupplierOrderRequest): SupplierOrderResponse {
    this.logger.debug(`[MOCK] Placing order for platform order ${req.platformOrderId}`);
    return {
      supplierOrderId: `SUP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      status: 'confirmed',
      estimatedShipDate: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    };
  }

  private mockTracking(supplierOrderId: string): SupplierTrackingResponse {
    return {
      supplierOrderId,
      trackingNumber: `1Z${Math.random().toString(36).slice(2, 18).toUpperCase()}`,
      trackingUrl: `https://tracking.mock.dev/${supplierOrderId}`,
      status: 'in_transit',
      shipped: true,
      delivered: false,
      estimatedDelivery: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    };
  }
}
