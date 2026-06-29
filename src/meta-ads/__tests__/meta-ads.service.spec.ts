import { Test, TestingModule } from '@nestjs/testing';
import { MetaAdsService } from '../meta-ads.service';
import { MetaApiClient } from '../meta-api.client';
import { DB_TOKEN } from '../../common/database/database.module';
import { CreativeGeneratorService } from '../../ad-creatives/creative-generator.service';
import { AiMediaService } from '../../ai-media/ai-media.service';

// ── DB chain mock ────────────────────────────────────────────────────────────
const dbMock = {
  insert:   jest.fn().mockReturnThis(),
  values:   jest.fn().mockReturnThis(),
  returning: jest.fn(),
  update:   jest.fn().mockReturnThis(),
  set:      jest.fn().mockReturnThis(),
  where:    jest.fn().mockReturnThis(),
  query: {
    campaigns:       { findFirst: jest.fn() },
    metaAdSets:      { findFirst: jest.fn() },
    metaAdCreatives: { findFirst: jest.fn() },
  },
};

// ── Meta API client mock ─────────────────────────────────────────────────────
const metaApiMock = {
  createCampaign:   jest.fn(),
  createAdSet:      jest.fn(),
  createAdCreative: jest.fn(),
  effectivePageId:  'page_123',
};

// ── Fixtures ─────────────────────────────────────────────────────────────────
const baseProduct = {
  id:           'prod-uuid-1',
  userId:       'user-uuid-1',
  title:        'Wireless Earbuds Pro',
  description:  'Crystal clear audio, noise cancellation.',
  decision:     'RUN_ADS',
  tags:         ['electronics', 'audio'],
  imageUrls:    ['https://cdn.example.com/img.jpg'],
  category:     'Electronics',
  supplierPrice: '350',
  sellingPrice:  '999',
  shopifyProductId: null,
  status: 'scored',
};

const fakeCampaign  = { id: 'camp-1', status: 'pending', externalId: null, updatedAt: new Date() };
const fakeAdSet     = { id: 'adset-1', status: 'pending', externalId: null, updatedAt: new Date() };
const fakeCreative  = { id: 'creative-1', status: 'pending', externalId: null, updatedAt: new Date() };

// ── Suite ────────────────────────────────────────────────────────────────────
describe('MetaAdsService', () => {
  let service: MetaAdsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Restore chain mocks
    dbMock.insert.mockReturnValue(dbMock);
    dbMock.values.mockReturnValue(dbMock);
    dbMock.update.mockReturnValue(dbMock);
    dbMock.set.mockReturnValue(dbMock);
    dbMock.where.mockReturnValue(dbMock);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetaAdsService,
        { provide: DB_TOKEN,      useValue: dbMock },
        { provide: MetaApiClient, useValue: metaApiMock },
        {
          provide: CreativeGeneratorService,
          useValue: {
            getBestCreativePair: jest.fn().mockResolvedValue({
              headline: 'Wireless Earbuds Pro',
              body: 'Crystal clear audio, noise cancellation.',
            }),
          },
        },
        { provide: AiMediaService, useValue: {} },
      ],
    }).compile();

    service = module.get<MetaAdsService>(MetaAdsService);
  });

  // ── autoLaunchIfEligible ─────────────────────────────────────────────────

  describe('autoLaunchIfEligible()', () => {
    it('skips REJECT products without calling launchCampaign', async () => {
      const spy = jest.spyOn(service, 'launchCampaign');
      await service.autoLaunchIfEligible('user-1', { ...baseProduct, decision: 'REJECT' } as any);
      expect(spy).not.toHaveBeenCalled();
    });

    it('skips PENDING products without calling launchCampaign', async () => {
      const spy = jest.spyOn(service, 'launchCampaign');
      await service.autoLaunchIfEligible('user-1', { ...baseProduct, decision: 'PENDING' } as any);
      expect(spy).not.toHaveBeenCalled();
    });

    it('calls launchCampaign with RUN_ADS', async () => {
      const spy = jest
        .spyOn(service, 'launchCampaign')
        .mockResolvedValue({ campaignId: 'c1', adSetId: 'a1', creativeId: 'cr1', assetId: null, mediaAssetId: null });

      await service.autoLaunchIfEligible('user-1', baseProduct as any);
      expect(spy).toHaveBeenCalledWith('user-1', baseProduct, 'RUN_ADS');
    });

    it('calls launchCampaign with TEST_ADS', async () => {
      const spy = jest
        .spyOn(service, 'launchCampaign')
        .mockResolvedValue({ campaignId: 'c2', adSetId: 'a2', creativeId: 'cr2', assetId: null, mediaAssetId: null });

      await service.autoLaunchIfEligible('user-1', { ...baseProduct, decision: 'TEST_ADS' } as any);
      expect(spy).toHaveBeenCalledWith('user-1', { ...baseProduct, decision: 'TEST_ADS' }, 'TEST_ADS');
    });

    it('does NOT throw when launchCampaign fails (safety guarantee)', async () => {
      jest.spyOn(service, 'launchCampaign').mockRejectedValue(new Error('network timeout'));
      await expect(
        service.autoLaunchIfEligible('user-1', baseProduct as any),
      ).resolves.toBeUndefined();
    });
  });

  // ── createCampaign ───────────────────────────────────────────────────────

  describe('createCampaign()', () => {
    beforeEach(() => {
      dbMock.returning.mockResolvedValue([fakeCampaign]);
      dbMock.query.campaigns.findFirst.mockResolvedValue(fakeCampaign);
    });

    it('uses CONVERSIONS objective for RUN_ADS', async () => {
      metaApiMock.createCampaign.mockResolvedValue({ id: 'meta_camp_run' });
      await service.createCampaign(baseProduct as any, 'user-1', 'RUN_ADS');
      expect(metaApiMock.createCampaign).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'CONVERSIONS' }),
      );
    });

    it('uses TRAFFIC objective for TEST_ADS', async () => {
      metaApiMock.createCampaign.mockResolvedValue({ id: 'meta_camp_test' });
      await service.createCampaign(baseProduct as any, 'user-1', 'TEST_ADS');
      expect(metaApiMock.createCampaign).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'TRAFFIC' }),
      );
    });

    it('sets campaign status to error when Meta API throws', async () => {
      metaApiMock.createCampaign.mockRejectedValue(new Error('API 500'));
      const result = await service.createCampaign(baseProduct as any, 'user-1', 'RUN_ADS');
      expect(dbMock.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' }),
      );
      expect(result.status).toBe("error");
    });

    it('inserts campaign with platform=meta', async () => {
      metaApiMock.createCampaign.mockResolvedValue({ id: 'meta_camp_x' });
      await service.createCampaign(baseProduct as any, 'user-1', 'RUN_ADS');
      expect(dbMock.values).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'meta', status: 'pending' }),
      );
    });
  });

  // ── createAdSet ──────────────────────────────────────────────────────────

  describe('createAdSet()', () => {
    beforeEach(() => {
      dbMock.returning.mockResolvedValue([fakeAdSet]);
      dbMock.query.campaigns.findFirst.mockResolvedValue({ id: 'camp-1', externalId: 'meta_camp_1' });
    });

    it('uses OFFSITE_CONVERSIONS goal for RUN_ADS', async () => {
      metaApiMock.createAdSet.mockResolvedValue({ id: 'meta_adset_run' });
      await service.createAdSet(baseProduct as any, 'user-1', 'camp-1', 'RUN_ADS');
      expect(metaApiMock.createAdSet).toHaveBeenCalledWith(
        expect.objectContaining({ optimization_goal: 'OFFSITE_CONVERSIONS' }),
      );
    });

    it('uses LINK_CLICKS goal for TEST_ADS', async () => {
      metaApiMock.createAdSet.mockResolvedValue({ id: 'meta_adset_test' });
      await service.createAdSet(baseProduct as any, 'user-1', 'camp-1', 'TEST_ADS');
      expect(metaApiMock.createAdSet).toHaveBeenCalledWith(
        expect.objectContaining({ optimization_goal: 'LINK_CLICKS' }),
      );
    });

    it('sets adset status to error when Meta API throws', async () => {
      metaApiMock.createAdSet.mockRejectedValue(new Error('rate limit'));
      const result = await service.createAdSet(baseProduct as any, 'user-1', 'camp-1', 'RUN_ADS');
      expect(result.status).toBe("error");
    });
  });

  // ── createAdCreative ─────────────────────────────────────────────────────

  describe('createAdCreative()', () => {
    beforeEach(() => {
      dbMock.returning.mockResolvedValue([fakeCreative]);
      dbMock.query.metaAdSets.findFirst.mockResolvedValue({ id: 'adset-1', externalId: 'meta_adset_1' });
    });

    it('passes SHOP_NOW CTA to Meta API', async () => {
      metaApiMock.createAdCreative.mockResolvedValue({ id: 'meta_creative_1' });
      await service.createAdCreative(baseProduct as any, 'user-1', 'camp-1', 'adset-1');
      expect(metaApiMock.createAdCreative).toHaveBeenCalledWith(
        expect.objectContaining({
          object_story_spec: expect.objectContaining({
            link_data: expect.objectContaining({
              call_to_action: { type: 'SHOP_NOW' },
            }),
          }),
        }),
      );
    });

    it('uses product description as ad body', async () => {
      metaApiMock.createAdCreative.mockResolvedValue({ id: 'meta_creative_2' });
      await service.createAdCreative(baseProduct as any, 'user-1', 'camp-1', 'adset-1');
      expect(dbMock.values).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('Crystal clear audio') }),
      );
    });

    it('uses fallback body when description is null', async () => {
      metaApiMock.createAdCreative.mockResolvedValue({ id: 'meta_creative_3' });
      await service.createAdCreative(
        { ...baseProduct, description: null } as any,
        'user-1', 'camp-1', 'adset-1',
      );
      expect(dbMock.values).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Crystal clear audio'),
        }),
      );
    });

    it('sets creative status to error when Meta API throws', async () => {
      metaApiMock.createAdCreative.mockRejectedValue(new Error('invalid image'));
      const result = await service.createAdCreative(baseProduct as any, 'user-1', 'camp-1', 'adset-1');
      expect(result.creative.status).toBe("error");
    });
  });
});
