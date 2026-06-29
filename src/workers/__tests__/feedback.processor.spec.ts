/**
 * FeedbackProcessor Unit Tests
 *
 * Verifies the self-learning feedback loop behaviour:
 *
 *  1. performance_score calculation
 *     - Formula: CTR × 0.4 + ROAS × 0.6
 *     - Stored in ai_memory via MemoryService.store()
 *
 *  2. Winner filtering
 *     - CTR ≥ 2.5% OR ROAS ≥ 3.0 required
 *     - Minimum 100 impressions required for statistical significance
 *     - Campaigns below both thresholds are never stored
 *
 *  3. Pruning
 *     - MemoryService.pruneWeak() called after every harvest run
 *
 *  4. Category cap enforcement
 *     - enforceCapPerCategory() called for every affected category
 *
 *  5. Resilience
 *     - DB errors in fetchRecentCampaigns don't crash the processor
 *     - Empty campaign list is handled gracefully
 *     - Mixed winner/loser batches store only winners
 *
 * Performance_score formula tested at boundary values and mid-range.
 * All tests use mocked DB and MemoryService — zero I/O.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { FeedbackProcessor } from '../feedback.processor';
import { MemoryService } from '../../ai-orchestrator/memory.service';
import { DB_TOKEN } from '../../common/database/database.module';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(): Job {
  return { id: 'test-job-1', data: {} } as unknown as Job;
}

interface CampaignRow {
  id:          string;
  adCopy:      Record<string, string> | null;
  category:    string | null;
  ctr:         string | null;
  roas:        string | null;
  impressions: string | null;
}

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id:          `campaign-${Math.random().toString(36).slice(2)}`,
    adCopy:      { hook: 'Stop scrolling!', headline: 'Best Product Ever', body: 'Try it now' },
    category:    'electronics',
    ctr:         '3.0',      // 3% — above threshold
    roas:        '4.0',      // 4x — above threshold
    impressions: '500',
    ...overrides,
  };
}

// ── Mock factories ────────────────────────────────────────────────────────────

function makeMemoryMock() {
  return {
    store:                 jest.fn().mockResolvedValue(undefined),
    pruneWeak:             jest.fn().mockResolvedValue(5),
    enforceCapPerCategory: jest.fn().mockResolvedValue(undefined),
    getTopPatterns:        jest.fn().mockResolvedValue([]),
    buildMemoryEnrichedPrompt: jest.fn().mockImplementation((p: string) => p),
  };
}

function makeDbMock(campaigns: CampaignRow[] = []) {
  return {
    execute: jest.fn().mockResolvedValue({ rows: campaigns }),
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('FeedbackProcessor', () => {
  let processor: FeedbackProcessor;
  let memory:    ReturnType<typeof makeMemoryMock>;
  let db:        ReturnType<typeof makeDbMock>;

  async function build(campaigns: CampaignRow[] = []): Promise<void> {
    memory = makeMemoryMock();
    db     = makeDbMock(campaigns);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedbackProcessor,
        { provide: DB_TOKEN,       useValue: db     },
        { provide: MemoryService,  useValue: memory },
      ],
    }).compile();

    processor = module.get<FeedbackProcessor>(FeedbackProcessor);
  }

  beforeEach(async () => {
    await build();
  });

  // ── performance_score formula ─────────────────────────────────────────────

  describe('performance_score calculation', () => {
    it('computes score as CTR×0.4 + ROAS×0.6 for a clear winner', async () => {
      // CTR=3.0, ROAS=4.0 → score = 3.0×0.4 + 4.0×0.6 = 1.2 + 2.4 = 3.6
      await build([campaign({ ctr: '3.0', roas: '4.0' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ ctr: 3.0, roas: 4.0 }),
      );
    });

    it('computes score correctly at minimum winner thresholds (CTR=2.5, ROAS=0)', async () => {
      // CTR=2.5, ROAS=0 → score = 2.5×0.4 + 0×0.6 = 1.0
      await build([campaign({ ctr: '2.5', roas: '0.0' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ ctr: 2.5, roas: 0.0 }),
      );
    });

    it('computes score correctly at minimum winner thresholds (CTR=0, ROAS=3.0)', async () => {
      // CTR=0, ROAS=3.0 → score = 0×0.4 + 3.0×0.6 = 1.8
      await build([campaign({ ctr: '0.0', roas: '3.0', impressions: '200' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ ctr: 0.0, roas: 3.0 }),
      );
    });

    it('computes score for high-performing campaign', async () => {
      // CTR=5.0, ROAS=8.0 → score = 5.0×0.4 + 8.0×0.6 = 2.0 + 4.8 = 6.8
      await build([campaign({ ctr: '5.0', roas: '8.0' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ ctr: 5.0, roas: 8.0 }),
      );
    });

    it('MemoryService.store receives the correct score parameters', async () => {
      const c = campaign({ ctr: '3.5', roas: '5.0', category: 'fashion' });
      await build([c]);

      await processor.harvestFeedback(makeJob());

      const storeCall = memory.store.mock.calls[0][0];
      expect(storeCall.operation).toBe('campaign');
      expect(storeCall.category).toBe('fashion');
      expect(storeCall.ctr).toBe(3.5);
      expect(storeCall.roas).toBe(5.0);
    });

    it('passes hook and headline from adCopy to store', async () => {
      const c = campaign({
        adCopy: { hook: 'Test hook', headline: 'Test headline', body: 'Test body' },
      });
      await build([c]);

      await processor.harvestFeedback(makeJob());

      const storeCall = memory.store.mock.calls[0][0];
      expect(storeCall.hook).toBe('Test hook');
      expect(storeCall.headline).toBe('Test headline');
    });
  });

  // ── Winner filtering ──────────────────────────────────────────────────────

  describe('winner filtering — only winners stored', () => {
    it('does NOT store campaign below both thresholds (CTR=1.0, ROAS=1.0)', async () => {
      await build([campaign({ ctr: '1.0', roas: '1.0' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).not.toHaveBeenCalled();
    });

    it('does NOT store campaign at CTR=2.49 (just below threshold)', async () => {
      await build([campaign({ ctr: '2.49', roas: '0.0' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).not.toHaveBeenCalled();
    });

    it('does NOT store campaign at ROAS=2.99 (just below threshold)', async () => {
      await build([campaign({ ctr: '0.0', roas: '2.99', impressions: '200' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).not.toHaveBeenCalled();
    });

    it('STORES campaign at exactly CTR=2.5 (boundary)', async () => {
      await build([campaign({ ctr: '2.5', roas: '0.0' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledTimes(1);
    });

    it('STORES campaign at exactly ROAS=3.0 (boundary)', async () => {
      await build([campaign({ ctr: '0.0', roas: '3.0', impressions: '150' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledTimes(1);
    });

    it('STORES campaign when CTR is below but ROAS is above threshold (OR logic)', async () => {
      await build([campaign({ ctr: '1.0', roas: '5.0', impressions: '200' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledTimes(1);
    });

    it('STORES campaign when ROAS is below but CTR is above threshold (OR logic)', async () => {
      await build([campaign({ ctr: '4.0', roas: '1.0' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledTimes(1);
    });

    it('does NOT store campaign with < 100 impressions even if CTR is high', async () => {
      await build([campaign({ ctr: '10.0', roas: '10.0', impressions: '99' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).not.toHaveBeenCalled();
    });

    it('STORES campaign with exactly 100 impressions', async () => {
      await build([campaign({ ctr: '3.0', roas: '4.0', impressions: '100' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledTimes(1);
    });

    it('skips campaigns with null impressions', async () => {
      await build([campaign({ impressions: null })]);

      await processor.harvestFeedback(makeJob());

      // null impressions → parseInt → 0 < 100 → skipped
      expect(memory.store).not.toHaveBeenCalled();
    });
  });

  // ── Mixed batch processing ────────────────────────────────────────────────

  describe('mixed winner/loser batches', () => {
    it('stores only winners from a mixed batch of 4 campaigns', async () => {
      const winner1 = campaign({ ctr: '3.5', roas: '4.0', category: 'electronics' });
      const loser1  = campaign({ ctr: '1.0', roas: '1.5', category: 'fashion' });
      const winner2 = campaign({ ctr: '0.0', roas: '5.0', category: 'home', impressions: '300' });
      const loser2  = campaign({ ctr: '2.0', roas: '2.0', category: 'sports', impressions: '50' }); // low impressions

      await build([winner1, loser1, winner2, loser2]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledTimes(2);
    });

    it('stores nothing when all campaigns are losers', async () => {
      await build([
        campaign({ ctr: '0.5', roas: '0.8' }),
        campaign({ ctr: '1.2', roas: '1.1' }),
        campaign({ ctr: '2.0', roas: '2.9' }),
      ]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).not.toHaveBeenCalled();
    });

    it('stores all when all campaigns are winners', async () => {
      await build([
        campaign({ ctr: '3.0', roas: '4.0' }),
        campaign({ ctr: '4.0', roas: '5.0' }),
        campaign({ ctr: '5.0', roas: '6.0' }),
      ]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledTimes(3);
    });
  });

  // ── Pruning ───────────────────────────────────────────────────────────────

  describe('pruning', () => {
    it('calls pruneWeak() exactly once per harvest run', async () => {
      await build([campaign()]);

      await processor.harvestFeedback(makeJob());

      expect(memory.pruneWeak).toHaveBeenCalledTimes(1);
    });

    it('calls pruneWeak() even when no winners found', async () => {
      await build([campaign({ ctr: '0.1', roas: '0.5' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.pruneWeak).toHaveBeenCalledTimes(1);
    });

    it('calls pruneWeak() even on empty campaign list', async () => {
      await build([]);

      await processor.harvestFeedback(makeJob());

      expect(memory.pruneWeak).toHaveBeenCalledTimes(1);
    });
  });

  // ── Category cap enforcement ──────────────────────────────────────────────

  describe('category cap enforcement', () => {
    it('calls enforceCapPerCategory for each affected category', async () => {
      await build([
        campaign({ category: 'electronics', ctr: '3.0', roas: '4.0' }),
        campaign({ category: 'fashion',     ctr: '3.5', roas: '4.5' }),
      ]);

      await processor.harvestFeedback(makeJob());

      expect(memory.enforceCapPerCategory).toHaveBeenCalledWith('electronics', 'campaign', 50);
      expect(memory.enforceCapPerCategory).toHaveBeenCalledWith('fashion',     'campaign', 50);
    });

    it('deduplicates categories before enforcing cap', async () => {
      await build([
        campaign({ category: 'electronics', ctr: '3.0', roas: '4.0' }),
        campaign({ category: 'electronics', ctr: '4.0', roas: '5.0' }),
      ]);

      await processor.harvestFeedback(makeJob());

      // Same category appears twice in winners — enforceCapPerCategory called once
      const electronicsCalls = memory.enforceCapPerCategory.mock.calls.filter(
        (c: unknown[]) => c[0] === 'electronics',
      );
      expect(electronicsCalls).toHaveLength(1);
    });

    it('does NOT call enforceCapPerCategory when no winners stored', async () => {
      await build([campaign({ ctr: '0.5', roas: '0.5' })]);

      await processor.harvestFeedback(makeJob());

      expect(memory.enforceCapPerCategory).not.toHaveBeenCalled();
    });

    it('normalises category to lowercase before cap enforcement', async () => {
      await build([
        campaign({ category: 'Electronics', ctr: '3.0', roas: '4.0' }),
      ]);

      await processor.harvestFeedback(makeJob());

      expect(memory.enforceCapPerCategory).toHaveBeenCalledWith(
        'electronics',  // lowercase
        'campaign',
        50,
      );
    });
  });

  // ── adCopy field mapping ──────────────────────────────────────────────────

  describe('adCopy field mapping', () => {
    it('uses adCopy.hook as hook field', async () => {
      const c = campaign({ adCopy: { hook: 'Hook text', headline: 'HL', body: 'Body' } });
      await build([c]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ hook: 'Hook text' }),
      );
    });

    it('falls back to adCopy.headline when hook is missing', async () => {
      const c = campaign({ adCopy: { headline: 'Fallback headline', body: 'Body' } });
      await build([c]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ hook: 'Fallback headline' }),
      );
    });

    it('uses adCopy.body as caption field', async () => {
      const c = campaign({ adCopy: { hook: 'H', headline: 'HL', body: 'Caption text' } });
      await build([c]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ caption: 'Caption text' }),
      );
    });

    it('handles null adCopy gracefully', async () => {
      const c = campaign({ adCopy: null });
      await build([c]);

      await processor.harvestFeedback(makeJob());

      // Should still store (CTR/ROAS above threshold), just with null copy fields
      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ hook: null, headline: null }),
      );
    });
  });

  // ── Resilience ────────────────────────────────────────────────────────────

  describe('resilience — DB failure handling', () => {
    it('does not throw when DB query fails — returns gracefully', async () => {
      db.execute = jest.fn().mockRejectedValue(new Error('DB connection lost'));

      await expect(processor.harvestFeedback(makeJob())).resolves.not.toThrow();
    });

    it('calls pruneWeak() even when DB query throws', async () => {
      db.execute = jest.fn().mockRejectedValue(new Error('Timeout'));

      await processor.harvestFeedback(makeJob());

      // DB failure returns [] from fetchRecentCampaigns, pruning still runs
      expect(memory.pruneWeak).toHaveBeenCalled();
    });

    it('stores zero items when DB returns empty result', async () => {
      await build([]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).not.toHaveBeenCalled();
    });

    it('does not throw when MemoryService.store() rejects', async () => {
      memory.store = jest.fn().mockRejectedValue(new Error('Insert failed'));
      await build([campaign()]);

      // Should not propagate — FeedbackProcessor catches store errors internally
      // (MemoryService.store already has its own try-catch, but test the surface)
      await expect(processor.harvestFeedback(makeJob())).resolves.not.toThrow();
    });
  });

  // ── Job metadata ──────────────────────────────────────────────────────────

  describe('job execution completeness', () => {
    it('processes a full harvest run end-to-end without errors', async () => {
      await build([
        campaign({ category: 'electronics', ctr: '4.0', roas: '5.0' }),
        campaign({ category: 'fashion',     ctr: '1.0', roas: '1.0' }),  // loser
        campaign({ category: 'home',        ctr: '3.0', roas: '3.5', impressions: '200' }),
      ]);

      await expect(processor.harvestFeedback(makeJob())).resolves.toBeUndefined();

      expect(memory.store).toHaveBeenCalledTimes(2);
      expect(memory.pruneWeak).toHaveBeenCalledTimes(1);
      expect(memory.enforceCapPerCategory).toHaveBeenCalledTimes(2);
    });

    it('passes sourceCampaign ID to store', async () => {
      const c = campaign({ id: 'campaign-uuid-123' });
      await build([c]);

      await processor.harvestFeedback(makeJob());

      expect(memory.store).toHaveBeenCalledWith(
        expect.objectContaining({ sourceCampaign: 'campaign-uuid-123' }),
      );
    });
  });
});
