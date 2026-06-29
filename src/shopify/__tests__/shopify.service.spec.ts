import { ShopifyService } from '../shopify.service';
import { ShopifyApiKeysService } from '../shopify-api-keys.service';
import { ShopifyAutoListingService } from '../shopify-auto-listing.service';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../../audit/audit.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ConfigService } from '@nestjs/config';
import * as nock from 'nock';

const SHOP_DOMAIN   = 'test-store.myshopify.com';
const ACCESS_TOKEN  = 'shpat_test_token';
const API_VERSION   = '2024-01';
const BASE_URL      = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}`;

const mockCreds = {
  id: 'key-1', userId: 'user-1',
  shopDomain: SHOP_DOMAIN, accessToken: ACCESS_TOKEN, webhookSecret: 'secret',
};

const mockShopifyProduct = {
  id: 9876543210,
  title: 'Test Widget',
  body_html: '<p>Widget description</p>',
  vendor: '', product_type: '', tags: 'tag1,tag2',
  status: 'draft' as const,
  variants: [{ id: 111, price: '39.99', compare_at_price: null, sku: '' }],
  images: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  handle: 'test-widget',
};

const mockShopifyOrders = [
  {
    id: 1234567890,
    order_number: 1001,
    email: 'customer@example.com',
    total_price: '39.99',
    subtotal_price: '39.99',
    currency: 'USD',
    financial_status: 'paid',
    fulfillment_status: null,
    created_at: new Date().toISOString(),
    line_items: [{ id: 1, title: 'Test Widget', quantity: 1, price: '39.99', sku: null, variant_id: 111, product_id: 9876543210 }],
    customer: { id: 999, email: 'customer@example.com', first_name: 'John', last_name: 'Doe' },
  },
];

describe('ShopifyService', () => {
  let service: ShopifyService;

  beforeAll(() => { nock.disableNetConnect(); });
  afterAll(() => { nock.enableNetConnect(); });
  afterEach(() => { nock.cleanAll(); });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ShopifyService],
    }).compile();
    service = module.get<ShopifyService>(ShopifyService);
  });

  // ── createProduct ────────────────────────────────────────────────────────

  describe('createProduct()', () => {
    it('posts to /products.json and returns created product', async () => {
      nock(BASE_URL)
        .post('/products.json')
        .reply(201, { product: mockShopifyProduct });

      const result = await service.createProduct(mockCreds, {
        title: 'Test Widget', price: 39.99, tags: ['tag1', 'tag2'], status: 'draft',
      });

      expect(result.id).toBe(9876543210);
      expect(result.title).toBe('Test Widget');
      expect(result.variants[0].price).toBe('39.99');
    });

    it('sends correct X-Shopify-Access-Token header', async () => {
      nock(BASE_URL, { reqheaders: { 'x-shopify-access-token': ACCESS_TOKEN } })
        .post('/products.json')
        .reply(201, { product: mockShopifyProduct });

      await expect(service.createProduct(mockCreds, { title: 'Widget', price: 10 })).resolves.toBeDefined();
    });

    it('maps imageUrls to Shopify images array', async () => {
      let capturedBody: unknown;
      nock(BASE_URL)
        .post('/products.json', (body: { product: { images: unknown[] } }) => {
          capturedBody = body;
          return true;
        })
        .reply(201, { product: mockShopifyProduct });

      await service.createProduct(mockCreds, {
        title: 'Widget', price: 10,
        imageUrls: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
      });

      const body = capturedBody as { product: { images: Array<{ src: string }> } };
      expect(body.product.images).toHaveLength(2);
      expect(body.product.images[0].src).toBe('https://example.com/img1.jpg');
    });

    it('throws BadGatewayException on HTTP 500', async () => {
      nock(BASE_URL).post('/products.json').reply(500, { error: 'server error' });
      await expect(service.createProduct(mockCreds, { title: 'Widget', price: 10 }))
        .rejects.toMatchObject({ status: 502 });
    });

    it('throws UnprocessableEntityException on HTTP 422 (validation error)', async () => {
      nock(BASE_URL).post('/products.json').reply(422, { errors: { title: ['is too short'] } });
      await expect(service.createProduct(mockCreds, { title: 'W', price: 10 }))
        .rejects.toMatchObject({ status: 422 });
    });
  });

  // ── updateProduct ────────────────────────────────────────────────────────

  describe('updateProduct()', () => {
    it('fetches existing product then puts update', async () => {
      nock(BASE_URL)
        .get('/products/9876543210.json')
        .reply(200, { product: mockShopifyProduct });

      nock(BASE_URL)
        .put('/products/9876543210.json')
        .reply(200, { product: { ...mockShopifyProduct, title: 'Updated Widget', status: 'active' } });

      const result = await service.updateProduct(mockCreds, '9876543210', {
        title: 'Updated Widget', status: 'active', price: 49.99,
      });

      expect(result.title).toBe('Updated Widget');
      expect(result.status).toBe('active');
    });

    it('skips GET when only title/status are changed (no variant update)', async () => {
      nock(BASE_URL)
        .put('/products/9876543210.json')
        .reply(200, { product: { ...mockShopifyProduct, title: 'New Title' } });

      const result = await service.updateProduct(mockCreds, '9876543210', { title: 'New Title' });
      expect(result.title).toBe('New Title');
    });
  });

  // ── getOrders ────────────────────────────────────────────────────────────

  describe('getOrders()', () => {
    it('fetches orders with default filters', async () => {
      nock(BASE_URL)
        .get('/orders.json')
        .query({ status: 'open', limit: '50' })
        .reply(200, { orders: mockShopifyOrders });

      const result = await service.getOrders(mockCreds);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1234567890);
      expect(result[0].total_price).toBe('39.99');
    });

    it('forwards custom filters to query params', async () => {
      nock(BASE_URL)
        .get('/orders.json')
        .query({ status: 'any', limit: '10', financial_status: 'paid' })
        .reply(200, { orders: [] });

      const result = await service.getOrders(mockCreds, {
        status: 'any', limit: 10, financial_status: 'paid',
      });
      expect(result).toHaveLength(0);
    });

    it('caps limit at 250', async () => {
      nock(BASE_URL)
        .get('/orders.json')
        .query((q) => q.limit === '250')
        .reply(200, { orders: [] });

      await service.getOrders(mockCreds, { limit: 9999 });
      // nock would not match if limit !== 250
    });
  });

  // ── registerWebhook ──────────────────────────────────────────────────────

  describe('registerWebhook()', () => {
    it('posts webhook registration', async () => {
      nock(BASE_URL)
        .post('/webhooks.json')
        .reply(201, { webhook: { id: 1, topic: 'orders/create' } });

      await expect(service.registerWebhook(
        mockCreds, 'orders/create', 'https://app.example.com/webhooks/shopify/order',
      )).resolves.not.toThrow();
    });

    it('does not throw on 422 (already registered)', async () => {
      nock(BASE_URL)
        .post('/webhooks.json')
        .reply(422, { errors: { address: ['for this topic has already been taken'] } });

      await expect(service.registerWebhook(
        mockCreds, 'orders/create', 'https://app.example.com/webhooks/shopify/order',
      )).resolves.not.toThrow();
    });
  });
});

// ── ShopifyApiKeysService ─────────────────────────────────────────────────────

describe('ShopifyApiKeysService', () => {
  let service: ShopifyApiKeysService;

  const dbMock = {
    query: { shopifyApiKeys: { findFirst: jest.fn() } },
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    dbMock.insert.mockReturnValue(dbMock);
    dbMock.values.mockReturnValue(dbMock);
    dbMock.update.mockReturnValue(dbMock);
    dbMock.set.mockReturnValue(dbMock);
    dbMock.where.mockReturnValue(dbMock);
    dbMock.delete.mockReturnValue(dbMock);

    const module = await Test.createTestingModule({
      providers: [
        ShopifyApiKeysService,
        { provide: DB_TOKEN, useValue: dbMock },
        {
          provide: EncryptionService,
          useValue: {
            encrypt: jest.fn((value: string) => value),
            decrypt: jest.fn((value: string) => value),
          },
        },
      ],
    }).compile();
    service = module.get(ShopifyApiKeysService);
  });

  it('save() inserts when no existing record', async () => {
    dbMock.query.shopifyApiKeys.findFirst.mockResolvedValueOnce(null);
    dbMock.returning.mockResolvedValueOnce([{ ...mockCreds }]);

    const result = await service.save('user-1', {
      shopDomain: SHOP_DOMAIN, accessToken: ACCESS_TOKEN,
    });
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(result.shopDomain).toBe(SHOP_DOMAIN);
  });

  it('save() updates when record already exists', async () => {
    dbMock.query.shopifyApiKeys.findFirst.mockResolvedValueOnce(mockCreds);
    dbMock.returning.mockResolvedValueOnce([{ ...mockCreds, accessToken: 'new-token' }]);

    const result = await service.save('user-1', {
      shopDomain: SHOP_DOMAIN, accessToken: 'new-token',
    });
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('getForUser() throws NotFoundException when no credentials', async () => {
    dbMock.query.shopifyApiKeys.findFirst.mockResolvedValueOnce(null);
    const { NotFoundException } = await import('@nestjs/common');
    await expect(service.getForUser('user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getForUser() returns credentials when found', async () => {
    dbMock.query.shopifyApiKeys.findFirst.mockResolvedValueOnce(mockCreds);
    const result = await service.getForUser('user-1');
    expect(result.shopDomain).toBe(SHOP_DOMAIN);
    expect(result.accessToken).toBe(ACCESS_TOKEN);
  });

  it('getByShopDomain() returns null when not found', async () => {
    dbMock.query.shopifyApiKeys.findFirst.mockResolvedValueOnce(null);
    const result = await service.getByShopDomain('unknown.myshopify.com');
    expect(result).toBeNull();
  });
});

// ── ShopifyAutoListingService ─────────────────────────────────────────────────

describe('ShopifyAutoListingService', () => {
  let service: ShopifyAutoListingService;

  const mockProduct = {
    id: 'prod-1', userId: 'user-1', title: 'Widget',
    description: 'A widget', supplierPrice: '10.00', sellingPrice: '39.99',
    decision: 'RUN_ADS', shopifyProductId: null, category: 'Electronics',
    tags: ['widget'], imageUrls: [], externalId: 'SKU-001', status: 'scored',
  };

  const dbMock = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  };

  const shopifyMock = {
    createProduct: jest.fn().mockResolvedValue({ id: 9876543210, title: 'Widget' }),
  };

  const apiKeysMock = {
    getForUser: jest.fn().mockResolvedValue(mockCreds),
  };

  const auditMock = { log: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    dbMock.update.mockReturnValue(dbMock);
    dbMock.set.mockReturnValue(dbMock);
    dbMock.where.mockReturnValue(dbMock);

    const module = await Test.createTestingModule({
      providers: [
        ShopifyAutoListingService,
        { provide: DB_TOKEN,                useValue: dbMock },
        { provide: ShopifyService,          useValue: shopifyMock },
        { provide: ShopifyApiKeysService,   useValue: apiKeysMock },
        { provide: AuditService,            useValue: auditMock },
      ],
    }).compile();
    service = module.get(ShopifyAutoListingService);
  });

  it('calls createProduct and persists shopifyProductId for RUN_ADS', async () => {
    await service.autoListIfEligible('user-1', mockProduct as unknown as typeof import('../../common/database/schema').products.$inferSelect);
    expect(shopifyMock.createProduct).toHaveBeenCalledTimes(1);
    expect(dbMock.update).toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'product.listed' }));
  });

  it('skips when decision is not RUN_ADS', async () => {
    await service.autoListIfEligible('user-1', { ...mockProduct, decision: 'TEST_ADS' } as unknown as typeof import('../../common/database/schema').products.$inferSelect);
    expect(shopifyMock.createProduct).not.toHaveBeenCalled();
  });

  it('skips when shopifyProductId already set', async () => {
    await service.autoListIfEligible('user-1', { ...mockProduct, shopifyProductId: '111' } as unknown as typeof import('../../common/database/schema').products.$inferSelect);
    expect(shopifyMock.createProduct).not.toHaveBeenCalled();
  });

  it('does NOT throw when Shopify call fails (non-fatal)', async () => {
    shopifyMock.createProduct.mockRejectedValueOnce(new Error('Shopify timeout'));
    await expect(service.autoListIfEligible('user-1', mockProduct as unknown as typeof import('../../common/database/schema').products.$inferSelect)).resolves.not.toThrow();
  });

  it('skips silently when user has no Shopify credentials', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    apiKeysMock.getForUser.mockRejectedValueOnce(new NotFoundException('No credentials'));
    await expect(service.autoListIfEligible('user-1', mockProduct as unknown as typeof import('../../common/database/schema').products.$inferSelect)).resolves.not.toThrow();
    expect(shopifyMock.createProduct).not.toHaveBeenCalled();
  });
});
