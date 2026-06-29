import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ProductsService } from '../products.service';
import { TrendFetcher } from '../engines/trend.fetcher';
import { AuditService } from '../../audit/audit.service';
import { ShopifyAutoListingService } from '../../shopify/shopify-auto-listing.service';
import { MetaAdsService } from '../../meta-ads/meta-ads.service';
import { AiJobService } from '../../workers/ai-job.service';
import { DB_TOKEN } from '../../common/database/database.module';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockProduct = {
  id: 'prod-1',
  userId: 'user-1',
  title: 'Wireless Earbuds',
  description: 'Good earbuds',
  supplierPrice: '12.00',
  sellingPrice: '39.99',
  decision: 'PENDING' as const,
  status: 'pending' as const,
  externalId: null,
  category: 'Electronics',
  tags: ['audio'],
  imageUrls: [],
  shopifyProductId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  scoredAt: null,
  listedAt: null,
};

const scoredProduct = {
  ...mockProduct,
  decision: 'RUN_ADS' as const,
  status: 'scored' as const,
  demandScore: '72.00',
  competitionScore: '60.00',
  marginScore: '80.00',
  trendIndex: '65.00',
  compositeScore: '72.00',
  decisionReason: 'Strong composite score',
  scoredAt: new Date(),
};

const scoredTestAdsProduct = {
  ...scoredProduct,
  decision: 'TEST_ADS' as const,
  compositeScore: '55.00',
};

// ── DB chain mock ─────────────────────────────────────────────────────────────

const dbChain = {
  select:    jest.fn().mockReturnThis(),
  from:      jest.fn().mockReturnThis(),
  where:     jest.fn().mockReturnThis(),
  limit:     jest.fn().mockReturnThis(),
  offset:    jest.fn().mockReturnThis(),
  orderBy:   jest.fn().mockReturnThis(),
  insert:    jest.fn().mockReturnThis(),
  values:    jest.fn().mockReturnThis(),
  returning: jest.fn(),
  update:    jest.fn().mockReturnThis(),
  set:       jest.fn().mockReturnThis(),
  delete:    jest.fn().mockReturnThis(),
};

// ── Service mocks ─────────────────────────────────────────────────────────────

const trendFetcherMock = { fetchTrendIndex: jest.fn().mockResolvedValue(65) };
const auditMock        = { log: jest.fn().mockResolvedValue(undefined) };
const autoListingMock  = { autoListIfEligible: jest.fn().mockResolvedValue(undefined) };
const metaAdsMock      = { autoLaunchIfEligible: jest.fn().mockResolvedValue(undefined) };

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ProductsService', () => {
  let service: ProductsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset all chain methods
    Object.keys(dbChain).forEach((k) => {
      const key = k as keyof typeof dbChain;
      if (key !== 'returning') {
        (dbChain[key] as jest.Mock).mockReturnValue(dbChain);
      }
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: DB_TOKEN,                  useValue: dbChain },
        { provide: TrendFetcher,              useValue: trendFetcherMock },
        { provide: AuditService,              useValue: auditMock },
        { provide: ShopifyAutoListingService, useValue: autoListingMock },
        { provide: MetaAdsService,            useValue: metaAdsMock },
        { provide: AiJobService,              useValue: { createJob: jest.fn().mockResolvedValue({ id: 'job-1' }) } },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  // ── createProduct ─────────────────────────────────────────────────────────

  describe('createProduct()', () => {
    it('inserts and returns the created product', async () => {
      dbChain.returning.mockResolvedValueOnce([mockProduct]);

      const result = await service.createProduct('user-1', {
        title: 'Wireless Earbuds',
        supplierPrice: 12,
        estimatedSellingPrice: 39.99,
        category: 'Electronics',
        tags: ['audio'],
      });

      expect(dbChain.insert).toHaveBeenCalledTimes(1);
      expect(result.title).toBe('Wireless Earbuds');
      expect(result.id).toBe('prod-1');
    });

    it('sets sellingPrice to null when estimatedSellingPrice is not provided', async () => {
      dbChain.returning.mockResolvedValueOnce([mockProduct]);

      await service.createProduct('user-1', { title: 'Widget', supplierPrice: 5 });

      expect(dbChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ sellingPrice: null }),
      );
    });

    it('defaults supplierType to "mock" when not provided', async () => {
      dbChain.returning.mockResolvedValueOnce([mockProduct]);

      await service.createProduct('user-1', { title: 'Widget', supplierPrice: 5 });

      expect(dbChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ supplierType: 'mock' }),
      );
    });
  });

  // ── getProduct ────────────────────────────────────────────────────────────

  describe('getProduct()', () => {
    it('returns product when found and owned by user', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      const result = await service.getProduct('user-1', 'prod-1');
      expect(result.id).toBe('prod-1');
      expect(result.userId).toBe('user-1');
    });

    it('throws NotFoundException when product not found', async () => {
      dbChain.limit.mockResolvedValueOnce([]);
      await expect(service.getProduct('user-1', 'nonexistent'))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when product belongs to different user', async () => {
      dbChain.limit.mockResolvedValueOnce([]);
      await expect(service.getProduct('other-user', 'prod-1'))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── listProducts ──────────────────────────────────────────────────────────

  describe('listProducts()', () => {
    it('returns products for the given user', async () => {
      dbChain.offset.mockResolvedValueOnce([mockProduct]);
      const result = await service.listProducts('user-1', 1, 20);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('applies correct pagination offset', async () => {
      dbChain.offset.mockResolvedValueOnce([]);
      await service.listProducts('user-1', 3, 10);
      expect(dbChain.offset).toHaveBeenCalledWith(20);
    });
  });

  // ── scoreAndDecide ────────────────────────────────────────────────────────

  describe('scoreAndDecide()', () => {
    it('calls TrendFetcher, updates product, writes audit log', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      dbChain.returning.mockResolvedValueOnce([scoredProduct]);

      await service.scoreAndDecide('user-1', 'prod-1');

      expect(trendFetcherMock.fetchTrendIndex).toHaveBeenCalledWith('Wireless Earbuds');
      expect(dbChain.update).toHaveBeenCalledTimes(1);
      expect(dbChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'scored', scoredAt: expect.any(Date) }),
      );
      expect(auditMock.log).toHaveBeenCalledTimes(1);
    });

    it('uses estimatedSellingPrice from overrides when provided', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      dbChain.returning.mockResolvedValueOnce([scoredProduct]);

      await service.scoreAndDecide('user-1', 'prod-1', { estimatedSellingPrice: 55 });

      expect(dbChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ sellingPrice: '55' }),
      );
    });

    it('falls back to product.sellingPrice when no override', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      dbChain.returning.mockResolvedValueOnce([scoredProduct]);

      await service.scoreAndDecide('user-1', 'prod-1');

      expect(dbChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ sellingPrice: '39.99' }),
      );
    });

    it('computes sellingPrice as 2.5x supplierPrice when both are missing', async () => {
      const productNoPrice = { ...mockProduct, sellingPrice: null };
      dbChain.limit.mockResolvedValueOnce([productNoPrice]);
      dbChain.returning.mockResolvedValueOnce([scoredProduct]);

      await service.scoreAndDecide('user-1', 'prod-1');

      expect(dbChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ sellingPrice: '30' }), // 12 * 2.5 = 30
      );
    });

    it('triggers Shopify auto-listing (fire-and-forget) after scoring', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      dbChain.returning.mockResolvedValueOnce([scoredProduct]);

      await service.scoreAndDecide('user-1', 'prod-1');

      expect(autoListingMock.autoListIfEligible).toHaveBeenCalledWith(
        'user-1', scoredProduct,
      );
    });

    it('triggers Meta Ads auto-launch (fire-and-forget) after scoring', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      dbChain.returning.mockResolvedValueOnce([scoredProduct]);

      await service.scoreAndDecide('user-1', 'prod-1');

      expect(metaAdsMock.autoLaunchIfEligible).toHaveBeenCalledWith(
        'user-1', scoredProduct,
      );
    });

    it('triggers Meta Ads for TEST_ADS decision as well', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      dbChain.returning.mockResolvedValueOnce([scoredTestAdsProduct]);

      await service.scoreAndDecide('user-1', 'prod-1');

      expect(metaAdsMock.autoLaunchIfEligible).toHaveBeenCalledWith(
        'user-1', scoredTestAdsProduct,
      );
    });

    it('writes product.rejected audit action when decision is REJECT', async () => {
      trendFetcherMock.fetchTrendIndex.mockResolvedValueOnce(5);
      const rejectedProduct = {
        ...mockProduct,
        supplierPrice: '49.00',
        sellingPrice:  '50.00',
      };
      dbChain.limit.mockResolvedValueOnce([rejectedProduct]);
      dbChain.returning.mockResolvedValueOnce([
        { ...rejectedProduct, decision: 'REJECT', status: 'scored' },
      ]);

      await service.scoreAndDecide('user-1', 'prod-1');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'product.rejected' }),
      );
    });
  });

  // ── deleteProduct ─────────────────────────────────────────────────────────

  describe('deleteProduct()', () => {
    it('deletes product when it exists and belongs to user', async () => {
      dbChain.limit.mockResolvedValueOnce([mockProduct]);
      dbChain.where
        .mockReturnValueOnce(dbChain)
        .mockResolvedValueOnce(undefined);

      await expect(service.deleteProduct('user-1', 'prod-1')).resolves.not.toThrow();
      expect(dbChain.delete).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when product not found', async () => {
      dbChain.limit.mockResolvedValueOnce([]);

      await expect(service.deleteProduct('user-1', 'nonexistent'))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(dbChain.delete).not.toHaveBeenCalled();
    });
  });
});
