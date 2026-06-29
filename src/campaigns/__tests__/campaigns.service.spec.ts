import { Test, TestingModule } from '@nestjs/testing';
import { CampaignsService } from '../campaigns.service';
import { AiBotService } from '../../ai-bot/ai-bot.service';
import { AuditService } from '../../audit/audit.service';
import { AiMediaService } from '../../ai-media/ai-media.service';
import { AiJobService } from '../../workers/ai-job.service';
import { StrategyService } from '../strategy.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { NotFoundException } from '@nestjs/common';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

const mockProduct = {
  id: 'prod-1', userId: 'user-1', title: 'Widget', category: 'Electronics',
  supplierPrice: '10.00', sellingPrice: '39.99', decision: 'RUN_ADS',
  compositeScore: '80.00', tags: ['widget'], status: 'scored',
};

const mockCampaign = {
  id: 'camp-1', userId: 'user-1', productId: 'prod-1', platform: 'meta',
  name: 'AI Campaign', status: 'draft', aiGenerated: true, createdAt: new Date(),
};

const mockBotResult = {
  content: { headline: 'Buy Widget Now!', body: 'Great widget.', cta: 'Shop Now', audience: {}, keywords: ['widget'] },
  mode: 'BOT' as const,
  operation: 'campaign',
  latencyMs: 12,
};

const dbMock = {
  query: { products: { findFirst: jest.fn() }, campaigns: { findFirst: jest.fn(), findMany: jest.fn() } },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn(),
};

const aiBotMock = { dispatch: jest.fn().mockResolvedValue(mockBotResult) };
const auditMock  = { log: jest.fn() };
const aiMediaMock = {};
const jobServiceMock = {
  createJob: jest.fn()
    .mockResolvedValueOnce({ jobId: 'campaign-job-1' })
    .mockResolvedValueOnce({ jobId: 'media-job-1' }),
};
const strategyMock = { evaluate: jest.fn() };
const mockUser: JwtPayload = { sub: 'user-1', email: 'u@t.com', role: 'user', subscriptionTier: 'pro' };

describe('CampaignsService', () => {
  let service: CampaignsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    dbMock.insert.mockReturnValue(dbMock);
    dbMock.values.mockReturnValue(dbMock);
    jobServiceMock.createJob
      .mockResolvedValueOnce({ jobId: 'campaign-job-1' })
      .mockResolvedValueOnce({ jobId: 'media-job-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: DB_TOKEN,        useValue: dbMock },
        { provide: AiBotService,    useValue: aiBotMock },
        { provide: AuditService,    useValue: auditMock },
        { provide: AiMediaService,  useValue: aiMediaMock },
        { provide: AiJobService,    useValue: jobServiceMock },
        { provide: StrategyService, useValue: strategyMock },
      ],
    }).compile();

    service = module.get<CampaignsService>(CampaignsService);
  });

  describe('generate()', () => {
    it('dispatches to AI/BOT, persists campaign, writes audit', async () => {
      dbMock.query.products.findFirst.mockResolvedValueOnce(mockProduct);
      dbMock.returning.mockResolvedValueOnce([mockCampaign]);

      const result = await service.generate(mockUser, { productId: 'prod-1', platform: 'meta' });

      expect(aiBotMock.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', operation: 'campaign' }),
      );
      expect(result.campaign.id).toBe('camp-1');
      expect(result.mode).toBe('BOT');
      expect(result.jobId).toBe('campaign-job-1');
      expect(result.mediaJobId).toBe('media-job-1');
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'campaign.generated' }),
      );
      expect(jobServiceMock.createJob).toHaveBeenCalledTimes(2);
    });

    it('throws NotFoundException when product not found', async () => {
      dbMock.query.products.findFirst.mockResolvedValueOnce(null);
      await expect(service.generate(mockUser, { productId: 'ghost' })).rejects.toBeInstanceOf(NotFoundException);
      expect(aiBotMock.dispatch).not.toHaveBeenCalled();
    });

    it('passes product context to dispatch', async () => {
      dbMock.query.products.findFirst.mockResolvedValueOnce(mockProduct);
      dbMock.returning.mockResolvedValueOnce([mockCampaign]);

      await service.generate(mockUser, { productId: 'prod-1', platform: 'google' });

      expect(aiBotMock.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            title:    'Widget',
            category: 'Electronics',
            platform: 'google',
          }),
        }),
      );
    });
  });

  describe('findOne()', () => {
    it('returns campaign when found', async () => {
      dbMock.query.campaigns.findFirst.mockResolvedValueOnce(mockCampaign);
      const result = await service.findOne('user-1', 'camp-1');
      expect(result.id).toBe('camp-1');
    });

    it('throws NotFoundException when not found', async () => {
      dbMock.query.campaigns.findFirst.mockResolvedValueOnce(null);
      await expect(service.findOne('user-1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findAll()', () => {
    it('returns paginated list', async () => {
      dbMock.query.campaigns.findMany.mockResolvedValueOnce([mockCampaign]);
      const result = await service.findAll('user-1', 1, 10);
      expect(result.items).toHaveLength(1);
      expect(result.page).toBe(1);
    });
  });
});
