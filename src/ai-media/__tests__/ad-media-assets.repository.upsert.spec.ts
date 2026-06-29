/**
 * FIX 3: Additional tests for UPSERT ON CONFLICT DO NOTHING behavior
 * in AdMediaAssetsRepository.save().
 *
 * Verifies that concurrent requests cannot create duplicate rows for the
 * same prompt_hash, and that the conflict resolution correctly falls back
 * to fetching the existing row.
 */

import { AdMediaAssetsRepository, SaveAssetDto } from '../ad-media-assets.repository';

// ── DB mock factory ───────────────────────────────────────────────────────────

function makeDb(overrides: Record<string, unknown> = {}): any {
  const mockReturning = jest.fn().mockResolvedValue([
    {
      id:               'existing-asset-id',
      productId:        'prod-1',
      promptHash:       'abc123hash',
      imageUrl:         'https://img.example.com/1.jpg',
      videoUrl:         'https://vid.example.com/1.mp4',
      provider:         'open-generative-ai',
      generationTimeMs: 500,
      success:          true,
      useCount:         1,
      createdAt:        new Date(),
    },
  ]);
  const mockOnConflictDoNothing = jest.fn().mockReturnValue({
    returning: mockReturning,
  });

  return {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: mockOnConflictDoNothing,
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
    _mockOnConflictDoNothing: mockOnConflictDoNothing,
    _mockReturning: mockReturning,
    ...overrides,
  };
}

const BASE_DTO: SaveAssetDto = {
  productId:        'prod-abc',
  campaignId:       null,
  imageUrl:         'https://img.example.com/new.jpg',
  videoUrl:         'https://vid.example.com/new.mp4',
  promptHash:       'deadbeef01234567deadbeef01234567deadbeef01234567deadbeef01234567',
  provider:         'open-generative-ai',
  generationTimeMs: 800,
  success:          true,
};

describe('AdMediaAssetsRepository — UPSERT / ON CONFLICT', () => {
  let repo: AdMediaAssetsRepository;
  let db:   ReturnType<typeof makeDb>;

  beforeEach(() => {
    db   = makeDb();
    repo = new AdMediaAssetsRepository(db);
  });

  it('should call onConflictDoNothing when saving (not plain insert)', async () => {
    await repo.save(BASE_DTO);
    expect(db._mockOnConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.anything() }),
    );
  });

  it('should return the saved row on first insert (no conflict)', async () => {
    const newRow = { id: 'new-id', ...BASE_DTO, useCount: 1, createdAt: new Date() };
    db._mockReturning.mockResolvedValue([newRow]);

    const result = await repo.save(BASE_DTO);
    expect(result?.id).toBe('new-id');
  });

  it('should fall back to findByHash when onConflictDoNothing returns empty (conflict)', async () => {
    // Simulate: another concurrent request already inserted the row → conflict
    db._mockReturning.mockResolvedValue([]);  // empty = conflict, nothing inserted

    const existingRow = {
      id:         'existing-concurrent-id',
      promptHash: BASE_DTO.promptHash,
      success:    true,
      useCount:   3,
    };

    // findByHash (select) should return the existing row
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([existingRow]),
        }),
      }),
    });

    const result = await repo.save(BASE_DTO);
    expect(result?.id).toBe('existing-concurrent-id');
    expect(result?.useCount).toBe(3);
  });

  it('should return null when both insert and fallback find return nothing', async () => {
    db._mockReturning.mockResolvedValue([]);  // conflict
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),  // also empty
        }),
      }),
    });

    const result = await repo.save(BASE_DTO);
    expect(result).toBeNull();
  });

  it('should return null and not throw when insert throws DB error', async () => {
    db._mockReturning.mockRejectedValue(new Error('connection lost'));

    const result = await repo.save(BASE_DTO);
    expect(result).toBeNull();
  });

  it('should not serve a failed (success=false) cache entry from findByHash', async () => {
    const failedRow = {
      id:         'failed-asset',
      promptHash: 'somehash',
      success:    false,   // ← failed generation cached
      useCount:   1,
    };

    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([failedRow]),
        }),
      }),
    });

    const result = await repo.findByHash('somehash');
    expect(result).toBeNull();  // must not return failed entries
  });

  it('buildPromptHash should be deterministic', () => {
    const h1 = AdMediaAssetsRepository.buildPromptHash('title', 'niche', 'style');
    const h2 = AdMediaAssetsRepository.buildPromptHash('title', 'niche', 'style');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);  // SHA-256 hex
  });

  it('buildPromptHash should produce different hashes for different inputs', () => {
    const h1 = AdMediaAssetsRepository.buildPromptHash('title-A', 'niche', 'style');
    const h2 = AdMediaAssetsRepository.buildPromptHash('title-B', 'niche', 'style');
    expect(h1).not.toBe(h2);
  });
});
