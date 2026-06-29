import { Test, TestingModule } from '@nestjs/testing';
import { SupplierService, SupplierOrderRequest } from '../supplier.service';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';

const configMock = {
  get: jest.fn((key: string, def?: unknown) => {
    const map: Record<string, unknown> = {
      SUPPLIER_API_URL: 'https://mock-supplier.internal/api',
      NODE_ENV: 'development', // dev mode → uses mock responses
    };
    return map[key] ?? def;
  }),
};

const sampleRequest: SupplierOrderRequest = {
  platformOrderId: 'platform-order-1',
  supplierType:    'mock',
  items: [{ title: 'Widget', quantity: 2, unitPrice: 15.99 }],
  shippingAddress: { line1: '123 Main St', city: 'New York', country: 'US' },
  currency: 'USD',
};

describe('SupplierService', () => {
  let service: SupplierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupplierService,
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();
    service = module.get<SupplierService>(SupplierService);
  });

  describe('placeOrder()', () => {
    it('returns a supplier order response in dev mode', async () => {
      const result = await service.placeOrder(sampleRequest);
      expect(result).toHaveProperty('supplierOrderId');
      expect(result).toHaveProperty('status');
      expect(typeof result.supplierOrderId).toBe('string');
      expect(result.supplierOrderId.startsWith('SUP-')).toBe(true);
    });

    it('returns confirmed status in dev mock', async () => {
      const result = await service.placeOrder(sampleRequest);
      expect(result.status).toBe('confirmed');
    });

    it('includes estimatedShipDate in mock response', async () => {
      const result = await service.placeOrder(sampleRequest);
      expect(result.estimatedShipDate).toBeDefined();
      expect(new Date(result.estimatedShipDate!).getTime()).toBeGreaterThan(Date.now());
    });

    it('each call returns a unique supplierOrderId', async () => {
      const r1 = await service.placeOrder(sampleRequest);
      const r2 = await service.placeOrder(sampleRequest);
      expect(r1.supplierOrderId).not.toBe(r2.supplierOrderId);
    });
  });

  describe('trackOrder()', () => {
    it('returns tracking response with required fields', async () => {
      const result = await service.trackOrder('SUP-12345', 'mock');
      expect(result).toHaveProperty('trackingNumber');
      expect(result).toHaveProperty('trackingUrl');
      expect(result).toHaveProperty('shipped');
      expect(result).toHaveProperty('delivered');
      expect(result.shipped).toBe(true);
      expect(result.delivered).toBe(false);
    });

    it('trackingUrl contains the supplierOrderId', async () => {
      const orderId = 'SUP-TEST-99';
      const result  = await service.trackOrder(orderId, 'mock');
      expect(result.trackingUrl).toContain(orderId);
    });
  });

  describe('circuit breaker', () => {
    it('circuit breaker is instantiated', () => {
      // Verify the circuit breaker is attached to the service
      expect((service as unknown as { breaker: unknown }).breaker).toBeDefined();
    });
  });
});
