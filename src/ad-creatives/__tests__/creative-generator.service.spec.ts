import { Test, TestingModule } from '@nestjs/testing';
import { CreativeGeneratorService } from '../creative-generator.service';
import { AiCreativeProviderService } from '../ai-creative-provider.service';
import {
  buildHooks, buildCaptions, buildHeadlines, buildVideoScript,
  buildCreativeBundle,
} from '../template-engine';
import { DB_TOKEN } from '../../common/database/database.module';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockInsertReturning = jest.fn().mockResolvedValue([
  {
    id: 'test-asset-uuid',
    productId: 'prod-uuid',
    userId: 'user-uuid',
    campaignId: null,
    hooks: ['hook1', 'hook2', 'hook3'],
    captions: ['cap1', 'cap2', 'cap3'],
    headlines: ['head1', 'head2'],
    videoScript: { hook: 'h', problem: 'p', solution: 's', cta: 'c' },
    aiGenerated: false,
    model: 'template',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);

const mockDb = {
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: mockInsertReturning,
    }),
  }),
  query: {
    products: { findFirst: jest.fn() },
  },
};

const makeAiProvider = (hasKey: boolean) => ({
  hasRealKey: hasKey,
  generate: jest.fn().mockImplementation(async (ctx) => ({
    bundle: buildCreativeBundle(ctx),
    aiGenerated: false,
    model: 'template-fallback',
    latencyMs: 0,
  })),
});

// ── Shared product fixture ────────────────────────────────────────────────────

function makeProduct(overrides = {}) {
  return {
    id: 'prod-uuid',
    userId: 'user-uuid',
    title: 'Premium Wireless Earbuds',
    category: 'electronics',
    description: 'High-quality sound with active noise cancellation.',
    tags: ['wireless', 'earbuds', 'noise-cancelling'],
    sellingPrice: '29.99',
    supplierPrice: '12.00',
    externalId: null,
    supplierType: 'mock',
    currency: 'USD',
    imageUrls: [],
    demandScore: null,
    competitionScore: null,
    marginScore: null,
    trendIndex: null,
    compositeScore: null,
    decision: 'RUN_ADS' as const,
    decisionReason: null,
    status: 'scored' as const,
    shopifyProductId: null,
    // V44 required fields
    sourceUrl:       null,
    v44SupplierId:   null,
    supplierPayload: null,
    backupSuppliers: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    scoredAt: null,
    listedAt: null,
    ...overrides,
  };
}

// ── Template engine pure function tests ───────────────────────────────────────

describe('Template Engine — pure functions', () => {
  const ctx = {
    title:        'Posture Corrector Belt',
    category:     'health',
    description:  'Ergonomic support for your back and spine.',
    tags:         ['posture', 'ergonomic', 'health'],
    sellingPrice: '19.99',
  };

  it('buildHooks returns exactly 3 non-empty strings', () => {
    const hooks = buildHooks(ctx);
    expect(hooks).toHaveLength(3);
    hooks.forEach((h) => expect(typeof h).toBe('string'));
    hooks.forEach((h) => expect(h.length).toBeGreaterThan(10));
  });

  it('buildCaptions returns exactly 3 non-empty strings', () => {
    const caps = buildCaptions(ctx);
    expect(caps).toHaveLength(3);
    caps.forEach((c) => expect(c.length).toBeGreaterThan(10));
  });

  it('buildHeadlines returns exactly 2 strings each ≤ 60 chars', () => {
    const heads = buildHeadlines(ctx);
    expect(heads).toHaveLength(2);
    heads.forEach((h) => expect(h.length).toBeLessThanOrEqual(60));
  });

  it('buildVideoScript returns all four required fields', () => {
    const vs = buildVideoScript(ctx);
    expect(vs.hook).toBeTruthy();
    expect(vs.problem).toBeTruthy();
    expect(vs.solution).toBeTruthy();
    expect(vs.cta).toBeTruthy();
  });

  it('buildCreativeBundle returns complete bundle', () => {
    const b = buildCreativeBundle(ctx);
    expect(b.hooks).toHaveLength(3);
    expect(b.captions).toHaveLength(3);
    expect(b.headlines).toHaveLength(2);
    expect(b.videoScript).toHaveProperty('hook');
    expect(b.videoScript).toHaveProperty('problem');
    expect(b.videoScript).toHaveProperty('solution');
    expect(b.videoScript).toHaveProperty('cta');
  });

  it('works correctly without optional fields (no description, no tags)', () => {
    const minCtx = { title: 'Test Product', category: null, description: null, tags: [], sellingPrice: null };
    const b = buildCreativeBundle(minCtx);
    expect(b.hooks).toHaveLength(3);
    expect(b.captions).toHaveLength(3);
    expect(b.headlines).toHaveLength(2);
    expect(b.videoScript.cta).toBeTruthy();
  });
});

// ── CreativeGeneratorService — no-AI-key path ────────────────────────────────

describe('CreativeGeneratorService (template fallback — no AI key)', () => {
  let service: CreativeGeneratorService;
  const aiProvider = makeAiProvider(false);

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreativeGeneratorService,
        { provide: AiCreativeProviderService, useValue: aiProvider },
        { provide: DB_TOKEN, useValue: mockDb },
      ],
    }).compile();
    service = module.get(CreativeGeneratorService);
  });

  it('generateHooks returns 3 strings', async () => {
    const hooks = await service.generateHooks(makeProduct());
    expect(hooks).toHaveLength(3);
    hooks.forEach((h) => expect(typeof h).toBe('string'));
  });

  it('generateAdCopy returns 3 strings', async () => {
    const caps = await service.generateAdCopy(makeProduct());
    expect(caps).toHaveLength(3);
  });

  it('generateHeadlines returns 2 strings each ≤ 60 chars', async () => {
    const heads = await service.generateHeadlines(makeProduct());
    expect(heads).toHaveLength(2);
    heads.forEach((h) => expect(h.length).toBeLessThanOrEqual(60));
  });

  it('generateVideoScript returns valid VideoScript shape', async () => {
    const vs = await service.generateVideoScript(makeProduct());
    expect(vs.hook).toBeTruthy();
    expect(vs.problem).toBeTruthy();
    expect(vs.solution).toBeTruthy();
    expect(vs.cta).toBeTruthy();
  });

  it('generateAndStore inserts into DB and returns row', async () => {
    const row = await service.generateAndStore(makeProduct(), 'user-uuid');
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(row.id).toBe('test-asset-uuid');
  });

  it('generateAndStore never throws — returns fallback row on DB error', async () => {
    mockDb.insert.mockImplementationOnce(() => {
      throw new Error('DB down');
    });
    const row = await service.generateAndStore(makeProduct(), 'user-uuid');
    expect(row.id).toContain('fallback-');
    expect(row.model).toBe('template-fallback');
  });

  it('getBestCreativePair always returns usable headline and body', async () => {
    const pair = await service.getBestCreativePair(makeProduct(), 'user-uuid');
    expect(pair.headline).toBeTruthy();
    expect(pair.body).toBeTruthy();
    expect(pair.hooks).toHaveLength(3);
  });
});

// ── CreativeGeneratorService — AI key present path ───────────────────────────

describe('CreativeGeneratorService (AI provider active)', () => {
  let service: CreativeGeneratorService;
  const mockBundle = {
    hooks:       ['ai-hook-1', 'ai-hook-2', 'ai-hook-3'],
    captions:    ['ai-cap-1',  'ai-cap-2',  'ai-cap-3'],
    headlines:   ['ai-head-1', 'ai-head-2'],
    videoScript: { hook: 'ah', problem: 'ap', solution: 'as', cta: 'ac' },
  };
  const aiProvider = {
    hasRealKey: true,
    generate: jest.fn().mockResolvedValue({
      bundle:      mockBundle,
      aiGenerated: true,
      model:       'gpt-4o-mini',
      latencyMs:   500,
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreativeGeneratorService,
        { provide: AiCreativeProviderService, useValue: aiProvider },
        { provide: DB_TOKEN, useValue: mockDb },
      ],
    }).compile();
    service = module.get(CreativeGeneratorService);
  });

  it('calls AI provider generate()', async () => {
    await service.generateHooks(makeProduct());
    expect(aiProvider.generate).toHaveBeenCalledTimes(1);
  });

  it('returns AI hooks when provider succeeds', async () => {
    const hooks = await service.generateHooks(makeProduct());
    expect(hooks).toEqual(mockBundle.hooks);
  });

  it('falls back to templates if AI provider throws', async () => {
    aiProvider.generate.mockRejectedValueOnce(new Error('API 500'));
    const hooks = await service.generateHooks(makeProduct());
    expect(hooks).toHaveLength(3);
    // Should NOT be the AI hooks (fallback was used)
    expect(hooks[0]).not.toBe('ai-hook-1');
  });

  it('generateAndStore marks aiGenerated=true on AI row', async () => {
    mockInsertReturning.mockResolvedValueOnce([
      { ...makeProduct(), id: 'ai-row-id', aiGenerated: true, model: 'gpt-4o-mini',
        hooks: mockBundle.hooks, captions: mockBundle.captions,
        headlines: mockBundle.headlines, videoScript: mockBundle.videoScript,
        createdAt: new Date(), updatedAt: new Date() },
    ]);
    const row = await service.generateAndStore(makeProduct(), 'user-uuid');
    expect(row.aiGenerated).toBe(true);
  });
});
