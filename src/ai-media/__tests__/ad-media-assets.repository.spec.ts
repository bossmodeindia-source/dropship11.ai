import { Test, TestingModule } from '@nestjs/testing';
import { AdMediaAssetsRepository, SaveAssetDto } from '../ad-media-assets.repository';
import { DB_TOKEN } from '../../common/database/database.module';

// ── Mock DB chain builder ─────────────────────────────────────────────────────

function makeDbMock() {
  const returning  = jest.fn();
  const limit      = jest.fn().mockResolvedValue([]);
  const orderBy    = jest.fn().mockReturnValue({ limit });
  const where      = jest.fn().mockReturnValue({ limit, orderBy });
  const from       = jest.fn().mockReturnValue({ where });
  const set        = jest.fn().mockReturnValue({ where });
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values     = jest.fn().mockReturnValue({ returning, onConflictDoNothing });

  const select = jest.fn().mockReturnValue({ from });
  const insert = jest.fn().mockReturnValue({ values });
  const update = jest.fn().mockReturnValue({ set });

  return { select, insert, update, _internals: { returning, limit, orderBy, where, from, set, values, onConflictDoNothing } };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('AdMediaAssetsRepository', () => {
  let repo: AdMediaAssetsRepository;
  let db: ReturnType<typeof makeDbMock>;

  beforeEach(async () => {
    db = makeDbMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdMediaAssetsRepository,
        { provide: DB_TOKEN, useValue: db },
      ],
    }).compile();

    repo = module.get<AdMediaAssetsRepository>(AdMediaAssetsRepository);
  });

  // ── buildPromptHash ────────────────────────────────────────────────────────

  describe('buildPromptHash (static)', () => {
    it('returns 64-char lowercase hex', () => {
      const h = AdMediaAssetsRepository.buildPromptHash('Yoga Mat', 'fitness');
      expect(h).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
    });

    it('is deterministic', () => {
      const h1 = AdMediaAssetsRepository.buildPromptHash('A', 'B', 'C');
      const h2 = AdMediaAssetsRepository.buildPromptHash('A', 'B', 'C');
      expect(h1).toBe(h2);
    });

    it('trims whitespace before hashing', () => {
      const h1 = AdMediaAssetsRepository.buildPromptHash('  Yoga Mat  ', '  fitness  ');
      const h2 = AdMediaAssetsRepository.buildPromptHash('Yoga Mat', 'fitness');
      expect(h1).toBe(h2);
    });

    it('default style matches explicit ecom-1:1-9:16', () => {
      const h1 = AdMediaAssetsRepository.buildPromptHash('X', 'Y');
      const h2 = AdMediaAssetsRepository.buildPromptHash('X', 'Y', 'ecom-1:1-9:16');
      expect(h1).toBe(h2);
    });
  });

  // ── findByHash ─────────────────────────────────────────────────────────────

  describe('findByHash', () => {
    it('returns the row when found and success=true', async () => {
      const row = { id: 'a1', imageUrl: 'img', videoUrl: 'vid', success: true, useCount: 1 };
      db._internals.limit.mockResolvedValue([row]);

      expect(await repo.findByHash('hash123')).toEqual(row);
    });

    it('returns null when success=false (failed/fallback entry)', async () => {
      db._internals.limit.mockResolvedValue([
        { id: 'a2', imageUrl: 'mock', videoUrl: 'mock', success: false, useCount: 0 },
      ]);
      expect(await repo.findByHash('hash123')).toBeNull();
    });

    it('returns null on empty result', async () => {
      db._internals.limit.mockResolvedValue([]);
      expect(await repo.findByHash('nonexistent')).toBeNull();
    });

    it('returns null on DB error (treated as cache miss)', async () => {
      db._internals.limit.mockRejectedValue(new Error('connection reset'));
      expect(await repo.findByHash('hash123')).toBeNull();
    });
  });

  // ── save ──────────────────────────────────────────────────────────────────

  describe('save', () => {
    const dto: SaveAssetDto = {
      productId:        'prod-001',
      campaignId:       'camp-001',
      imageUrl:         'https://img.cdn/x.jpg',
      videoUrl:         'https://vid.cdn/x.mp4',
      promptHash:       'a'.repeat(64),
      provider:         'open-generative-ai',
      generationTimeMs: 3500,
      success:          true,
    };

    it('returns the saved row on success', async () => {
      const saved = { id: 'saved-001', ...dto, useCount: 1 };
      db._internals.returning.mockResolvedValue([saved]);

      const result = await repo.save(dto);
      expect(result).toEqual(saved);
      expect(db._internals.values).toHaveBeenCalledWith(
        expect.objectContaining({
          productId:        dto.productId,
          promptHash:       dto.promptHash,
          generationTimeMs: dto.generationTimeMs,
          success:          dto.success,
          useCount:         1,
        }),
      );
    });

    it('returns null when campaignId is undefined (nullable field)', async () => {
      const saved = { id: 'saved-002', ...dto, campaignId: null, useCount: 1 };
      db._internals.returning.mockResolvedValue([saved]);

      const result = await repo.save({ ...dto, campaignId: undefined });
      expect(result).toEqual(saved);
    });

    it('returns null on insert error (non-fatal)', async () => {
      db._internals.returning.mockRejectedValue(new Error('unique violation'));
      expect(await repo.save(dto)).toBeNull();
    });
  });

  // ── incrementUseCount ────────────────────────────────────────────────────

  describe('incrementUseCount', () => {
    it('issues an UPDATE without throwing', async () => {
      db._internals.where.mockResolvedValue([]);
      await expect(repo.incrementUseCount('asset-001')).resolves.toBeUndefined();
      expect(db.update).toHaveBeenCalled();
      expect(db._internals.set).toHaveBeenCalled();
    });

    it('silently swallows DB errors', async () => {
      db._internals.where.mockRejectedValue(new Error('lock timeout'));
      await expect(repo.incrementUseCount('asset-001')).resolves.toBeUndefined();
    });
  });

  // ── getBestCreative ──────────────────────────────────────────────────────

  describe('getBestCreative', () => {
    it('returns the highest use_count asset', async () => {
      const best = { id: 'top', imageUrl: 'img', videoUrl: 'vid', success: true, useCount: 99 };
      db._internals.limit.mockResolvedValue([best]);

      expect(await repo.getBestCreative('prod-001')).toEqual(best);
    });

    it('returns null when no assets exist', async () => {
      db._internals.limit.mockResolvedValue([]);
      expect(await repo.getBestCreative('prod-001')).toBeNull();
    });

    it('returns null on DB error', async () => {
      db._internals.limit.mockRejectedValue(new Error('timeout'));
      expect(await repo.getBestCreative('prod-001')).toBeNull();
    });
  });

  // ── listByProduct ────────────────────────────────────────────────────────

  describe('listByProduct', () => {
    it('returns ordered list of assets', async () => {
      const rows = [
        { id: '1', imageUrl: 'a', videoUrl: 'b', success: true, useCount: 5 },
        { id: '2', imageUrl: 'c', videoUrl: 'd', success: true, useCount: 2 },
      ];
      db._internals.limit.mockResolvedValue(rows);

      const result = await repo.listByProduct('prod-001', 10);
      expect(result).toEqual(rows);
    });

    it('returns empty array on DB error', async () => {
      db._internals.limit.mockRejectedValue(new Error('error'));
      expect(await repo.listByProduct('prod-001')).toEqual([]);
    });
  });
});
