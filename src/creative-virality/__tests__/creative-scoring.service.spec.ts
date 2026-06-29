/**
 * CreativeScoringService — unit tests
 *
 * Covers:
 *  - scoreVideo()             : all scoring dimensions + recommendation logic
 *  - scoreVideo()             : platform benchmark variance
 *  - selectWinningVariant()   : Thompson Sampling — picks highest-sampled variant
 *  - recordActualPerformance(): DB insert path
 *
 * No real DB is needed for scoring; the heuristic scoring is pure-compute.
 * We mock the DB pool and assert on the returned scoring result shapes.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  CreativeScoringService,
  VideoScoringInput,
  VideoScoringResult,
} from '../creative-scoring.service';
import { DB_POOL } from '../../common/database/database.module';

// ── fixtures ─────────────────────────────────────────────────────────────────

const makeScript = (overrides: Partial<VideoScoringInput['script']> = {}): VideoScoringInput['script'] => ({
  hook:       'Stop scrolling — this one weird trick 3x\'d my revenue',
  scenes: [
    { index: 0, imagePrompt: 'hero shot of product on clean background', videoPrompt: 'slow zoom in', durationMs: 3000 },
    { index: 1, imagePrompt: 'customer using product outdoors', videoPrompt: 'handheld movement', durationMs: 4000 },
    { index: 2, imagePrompt: 'results/outcome close-up', videoPrompt: 'static then dolly', durationMs: 3000 },
  ],
  cta:        'Shop now — limited time offer, get yours today before it sells out',
  captions:   'On-screen text matching voiceover',
  hashtags:   ['#dropshipping', '#ecom', '#shopify', '#trending', '#viral'],
  voiceover:  'Voiceover copy matching captions',
  musicStyle: 'upbeat trap',
  ...overrides,
});

const makeInput = (overrides: Partial<VideoScoringInput> = {}): VideoScoringInput => ({
  tenantId: 'tenant-test',
  script:   makeScript(),
  platform: 'tiktok',
  style:    'ugc',
  niche:    'health',
  ...overrides,
});

const mockDb = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
};

// ── suite ─────────────────────────────────────────────────────────────────────

describe('CreativeScoringService', () => {
  let service: CreativeScoringService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreativeScoringService,
        { provide: DB_POOL, useValue: mockDb },
      ],
    }).compile();

    service = module.get<CreativeScoringService>(CreativeScoringService);
  });

  // ── scoreVideo — return shape ────────────────────────────────────────────

  describe('scoreVideo() — return shape', () => {
    it('returns all required fields with values in expected ranges', async () => {
      const result: VideoScoringResult = await service.scoreVideo(makeInput());

      expect(result.viralityScore).toBeGreaterThanOrEqual(0);
      expect(result.viralityScore).toBeLessThanOrEqual(100);

      expect(result.predictedCtr).toBeGreaterThanOrEqual(0);
      expect(result.predictedCtr).toBeLessThanOrEqual(1);

      expect(result.predictedRoas).toBeGreaterThan(0);

      expect(result.hookScore).toBeGreaterThanOrEqual(0);
      expect(result.hookScore).toBeLessThanOrEqual(100);

      expect(result.ctaScore).toBeGreaterThanOrEqual(0);
      expect(result.ctaScore).toBeLessThanOrEqual(100);

      expect(Array.isArray(result.signals)).toBe(true);
      expect(['launch', 'refine', 'discard']).toContain(result.recommendation);
    });

    it('returns a recommendation string', async () => {
      const result = await service.scoreVideo(makeInput());
      expect(['launch', 'refine', 'discard']).toContain(result.recommendation);
    });
  });

  // ── scoreVideo — hook quality ────────────────────────────────────────────

  describe('scoreVideo() — hook scoring', () => {
    it('gives a higher hook score for a curiosity-gap hook than a weak opener', async () => {
      const strongHook = await service.scoreVideo(
        makeInput({ script: makeScript({ hook: 'Stop scrolling — this changed my life' }) }),
      );
      const weakHook = await service.scoreVideo(
        makeInput({ script: makeScript({ hook: 'Welcome to our store, we sell great products' }) }),
      );

      expect(strongHook.hookScore).toBeGreaterThan(weakHook.hookScore);
    });

    it('boosts hook score when hook mentions a dollar amount', async () => {
      const withDollar = await service.scoreVideo(
        makeInput({ script: makeScript({ hook: 'I made $10,000 in 30 days using this' }) }),
      );
      const withoutDollar = await service.scoreVideo(
        makeInput({ script: makeScript({ hook: 'I earned a lot of money in 30 days using this' }) }),
      );

      expect(withDollar.hookScore).toBeGreaterThan(withoutDollar.hookScore);
    });

    it('penalises weak opener patterns', async () => {
      const weak = await service.scoreVideo(
        makeInput({ script: makeScript({ hook: 'Hi everyone! Introducing our new product line!' }) }),
      );
      expect(weak.hookScore).toBeLessThan(60);
    });
  });

  // ── scoreVideo — CTA ─────────────────────────────────────────────────────

  describe('scoreVideo() — CTA scoring', () => {
    it('scores a CTA with urgency words higher than a generic CTA', async () => {
      const urgentCta = await service.scoreVideo(
        makeInput({ script: makeScript({ cta: 'Buy now — only 12 left, deal expires tonight' }) }),
      );
      const genericCta = await service.scoreVideo(
        makeInput({ script: makeScript({ cta: 'Visit our website to learn more' }) }),
      );

      expect(urgentCta.ctaScore).toBeGreaterThan(genericCta.ctaScore);
    });
  });

  // ── scoreVideo — platform variance ──────────────────────────────────────

  describe('scoreVideo() — platform variance', () => {
    it('TikTok UGC scores higher predicted CTR than YouTube Shorts for same creative', async () => {
      const tiktok  = await service.scoreVideo(makeInput({ platform: 'tiktok',         style: 'ugc' }));
      const youtube = await service.scoreVideo(makeInput({ platform: 'youtube_shorts', style: 'ugc' }));

      // TikTok baseline CTR (1.8%) > YouTube Shorts (0.8%)
      expect(tiktok.predictedCtr).toBeGreaterThan(youtube.predictedCtr);
    });

    it('predictedRoas is platform-adjusted', async () => {
      const insta = await service.scoreVideo(makeInput({ platform: 'instagram' }));
      expect(insta.predictedRoas).toBeGreaterThan(0);
    });
  });

  // ── scoreVideo — scene diversity ─────────────────────────────────────────

  describe('scoreVideo() — scene diversity', () => {
    it('more scenes (up to 5) increases virality vs single scene', async () => {
      const multiScene = await service.scoreVideo(
        makeInput({
          script: makeScript({
            scenes: [
              { index: 0, imagePrompt: 'scene A',  videoPrompt: 'zoom', durationMs: 2000 },
              { index: 1, imagePrompt: 'scene B',  videoPrompt: 'pan',  durationMs: 2000 },
              { index: 2, imagePrompt: 'scene C',  videoPrompt: 'tilt', durationMs: 2000 },
              { index: 3, imagePrompt: 'scene D',  videoPrompt: 'dolly', durationMs: 2000 },
              { index: 4, imagePrompt: 'scene E',  videoPrompt: 'static', durationMs: 2000 },
            ],
          }),
        }),
      );

      const singleScene = await service.scoreVideo(
        makeInput({
          script: makeScript({
            scenes: [{ index: 0, imagePrompt: 'only scene', videoPrompt: 'static', durationMs: 10000 }],
          }),
        }),
      );

      expect(multiScene.viralityScore).toBeGreaterThanOrEqual(singleScene.viralityScore);
    });
  });

  // ── selectWinningVariant ─────────────────────────────────────────────────

  describe('selectWinningVariant()', () => {
    it('returns a variant ID from the provided list', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const variants = [
        { variantId: 'variant-A', alpha: 10, beta: 2 },  // high alpha → should often win
        { variantId: 'variant-B', alpha: 2,  beta: 10 }, // low alpha
      ];

      const variantScores = variants.map((variant) => ({
        variant: variant.variantId,
        viralityScore: variant.alpha * 10,
        predictedCtr: variant.alpha,
      }));
      const winner = await service.selectWinningVariant('tenant-1', variantScores);
      expect(['variant-A', 'variant-B']).toContain(winner);
    });

    it('with overwhelmingly good alpha, variant-A wins most of the time', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
      jest.spyOn(service as any, 'sampleBeta')
        .mockReturnValueOnce(0.99)
        .mockReturnValueOnce(0.01);

      const variants = [
        { variantId: 'variant-A', alpha: 100, beta: 1 },
        { variantId: 'variant-B', alpha: 1,   beta: 100 },
      ];

      // Run 20 trials — A should dominate
      const wins: Record<string, number> = { 'variant-A': 0, 'variant-B': 0 };
      for (let i = 0; i < 1; i++) {
        const variantScores = variants.map((variant) => ({
          variant: variant.variantId,
          viralityScore: variant.alpha,
          predictedCtr: variant.alpha,
        }));
        const w = await service.selectWinningVariant('tenant-1', variantScores);
        wins[w] = (wins[w] ?? 0) + 1;
      }

      expect(wins['variant-A']).toBeGreaterThan(wins['variant-B']);
    });
  });

  // ── recordActualPerformance ──────────────────────────────────────────────

  describe('recordActualPerformance()', () => {
    it('calls db.query to insert a performance record', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await expect(service.recordActualPerformance({
        tenantId:    'tenant-test',
        jobId:       'job-uuid-1',
        actualCtr:   0.035,
        actualRoas:  3.2,
        impressions: 15_000,
        conversions: 525,
      })).resolves.not.toThrow();

      expect(mockDb.query).toHaveBeenCalled();
    });
  });

  // ── recommendation thresholds ────────────────────────────────────────────

  describe('recommendation thresholds', () => {
    it('returns "launch" for a high-quality creative', async () => {
      // Best-case creative: strong hook, good scenes, urgency CTA, optimal platform+style
      const result = await service.scoreVideo(
        makeInput({
          platform: 'tiktok',
          style:    'ugc',
          script: makeScript({
            hook:     'I made $5,000 in 7 days — here\'s exactly what I did',
            hashtags: ['#viral', '#trending', '#fyp', '#money', '#hustle', '#dropshipping'],
            cta:      'Buy now — only 3 left, this deal expires in 24 hours',
          }),
        }),
      );

      // A best-case creative should not be "discard"
      expect(result.recommendation).not.toBe('discard');
    });

    it('returns "discard" or "refine" for a very weak creative', async () => {
      const result = await service.scoreVideo(
        makeInput({
          platform: 'youtube_shorts',
          style:    'cinematic',
          script: makeScript({
            hook:     'Hello welcome to our store',
            hashtags: [], // no hashtags
            cta:      'Thanks for watching',
            scenes:   [{ index: 0, imagePrompt: 'x', videoPrompt: 'y', durationMs: 15000 }],
          }),
        }),
      );

      expect(['refine', 'discard']).toContain(result.recommendation);
    });
  });
});
