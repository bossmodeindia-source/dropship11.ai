/**
 * VideoPipelineService — unit tests
 *
 * Tests the orchestrator's job-management responsibilities:
 *  - enqueue()    : persists a job row + pushes to Bull queue
 *  - updateStatus(): idempotent status progression
 *  - execute()    : fails gracefully when required providers are unavailable
 *
 * Provider API calls (OpenAI, Flux, Runway, ElevenLabs, FFmpeg) are mocked
 * at the UserAiRouterService boundary — we don't make real HTTP calls in unit tests.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException }  from '@nestjs/common';
import { getQueueToken }       from '@nestjs/bullmq';
import {
  VideoPipelineService,
  VideoPipelineInput,
} from '../video-pipeline.service';
import { UserAiRouterService }         from '../../user-ai-connections/user-ai-router.service';
import { TelegramStorageFacade } from '../../telegram-storage/telegram-storage-facade.service';
import { CreativeScoringService }      from '../../creative-virality/creative-scoring.service';
import { DB_POOL } from '../../common/database/database.module';
import { CanonicalQueue } from '../../queue/canonical-queues';

// ── fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-video-test';
const JOB_ID    = 'job-uuid-pipeline-1';

const makeInput = (overrides: Partial<VideoPipelineInput> = {}): VideoPipelineInput => ({
  tenantId:           TENANT_ID,
  productName:        'AI Posture Corrector',
  productDescription: 'Wearable device that corrects posture using haptic feedback',
  targetAudience:     'adults 25-45 with desk jobs',
  platform:           'tiktok',
  style:              'ugc',
  durationSeconds:    15,
  language:           'en',
  niche:              'health',
  ...overrides,
});

// ── mocks ────────────────────────────────────────────────────────────────────

const mockDb = {
  query: jest.fn(),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'bull-job-1' }),
};

const mockUserAiRouter = {
  route: jest.fn(),
};

const mockTelegramStorage = {
  enqueueUpload: jest.fn().mockResolvedValue({ telegramFileId: 'tg-file-1', cdnUrl: 'https://cdn.example/vid.mp4' }),
};

const mockCreativeScoring = {
  scoreVideo: jest.fn().mockResolvedValue({
    viralityScore:   72,
    predictedCtr:    0.022,
    predictedRoas:   2.8,
    watchTimeScore:  65,
    engagementScore: 70,
    hookScore:       75,
    ctaScore:        68,
    signals:         ['strong hook'],
    recommendation: 'launch',
  }),
};

// ── suite ─────────────────────────────────────────────────────────────────────

describe('VideoPipelineService', () => {
  let orchestrator: VideoPipelineService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default DB: INSERT returns a job row; all other queries return empty
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO video_pipeline_jobs')) {
        return Promise.resolve({ rows: [{ id: JOB_ID }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoPipelineService,
        { provide: DB_POOL,                              useValue: mockDb              },
        { provide: getQueueToken(CanonicalQueue.CREATIVE_GENERATION), useValue: mockQueue },
        { provide: UserAiRouterService,                  useValue: mockUserAiRouter    },
        { provide: TelegramStorageFacade,          useValue: mockTelegramStorage },
        { provide: CreativeScoringService,               useValue: mockCreativeScoring },
      ],
    }).compile();

    orchestrator = module.get<VideoPipelineService>(VideoPipelineService);
  });

  // ── enqueue ──────────────────────────────────────────────────────────────

  describe('enqueue()', () => {
    it('inserts a job row and returns a jobId', async () => {
      const result = await orchestrator.enqueue(makeInput());

      expect(result.jobId).toBe(JOB_ID);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO video_pipeline_jobs'),
        expect.arrayContaining([TENANT_ID]),
      );
    });

    it('adds the job to the Bull queue with retry options', async () => {
      await orchestrator.enqueue(makeInput());

      expect(mockQueue.add).toHaveBeenCalledWith(
        'video-pipeline',
        expect.objectContaining({ jobId: JOB_ID }),
        expect.objectContaining({ attempts: expect.any(Number) }),
      );
    });

    it('propagates a queued status on the DB row', async () => {
      await orchestrator.enqueue(makeInput());

      const insertCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('INSERT INTO video_pipeline_jobs'),
      );
      expect(insertCall[0]).toContain("'queued'");
    });

    it('includes the AB variant in the job row', async () => {
      await orchestrator.enqueue(makeInput({ abVariant: 'B' }));

      const insertCall = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('INSERT INTO video_pipeline_jobs'),
      );
      expect(insertCall[1]).toContain('B');
    });
  });

  // ── execute — provider failure path ──────────────────────────────────────

  describe('execute() — no AI provider connected', () => {
    it('marks job as failed and re-throws when user has no provider', async () => {
      mockUserAiRouter.route.mockRejectedValue(
        new ForbiddenException('No AI provider connected for category \'reasoning\''),
      );

      await expect(orchestrator.execute(JOB_ID, makeInput()))
        .rejects.toThrow();

      // Job should be marked failed in DB
      const failUpdate = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('failed'),
      );
      expect(failUpdate).toBeDefined();
    });
  });

  // ── execute — happy path with mocked providers ────────────────────────────

  describe('execute() — full pipeline with mocked providers', () => {
    beforeEach(() => {
      // Bypass FFmpeg/fetch assembly — return a fake video buffer directly
      jest.spyOn(orchestrator as any, 'assembleVideo').mockResolvedValue(
        Buffer.from('fake-assembled-video-bytes'),
      );
      // Bypass real HTTP fetch for video clip URLs — return fake CDN urls
      jest.spyOn(orchestrator as any, 'generateVideoClips').mockResolvedValue([
        'https://api.dev.runwayml.com/clip_0.mp4',
        'https://api.dev.runwayml.com/clip_1.mp4',
        'https://api.dev.runwayml.com/clip_2.mp4',
      ]);
      // Script generation → reasoning provider
      mockUserAiRouter.route.mockImplementation(async (req: any) => {
        if (req.category === 'reasoning') {
          return {
            providerKey: 'openai',
            content: JSON.stringify({
              hook:       'This posture device 3x\'d my productivity',
              scenes: [
                { index: 0, imagePrompt: 'product hero', videoPrompt: 'zoom', durationMs: 5000 },
                { index: 1, imagePrompt: 'user at desk',  videoPrompt: 'pan',  durationMs: 5000 },
                { index: 2, imagePrompt: 'before/after',  videoPrompt: 'cut',  durationMs: 5000 },
              ],
              cta:        'Get yours now — limited stock',
              captions:   'On-screen captions',
              hashtags:   ['#posture', '#health'],
              voiceover:  'Voiceover script',
              musicStyle: 'chill lo-fi',
            }),
            contentUrl: undefined,
            rawResponse: null,
            usage: { promptTokens: 300, completionTokens: 600, totalTokens: 900, costUsd: 0.0045 },
            latencyMs: 1200,
            usedFallback: false,
          };
        }

        if (req.category === 'image_generation') {
          return {
            providerKey: 'flux',
            content:     null,
            contentUrl:  'https://cdn.bfl.ai/image.png',
            rawResponse: null,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0.055 },
            latencyMs: 4500,
            usedFallback: false,
          };
        }

        if (req.category === 'video_generation') {
          return {
            providerKey: 'runway',
            content:     null,
            contentUrl:  'https://api.dev.runwayml.com/video.mp4',
            rawResponse: null,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0.25 },
            latencyMs: 45000,
            usedFallback: false,
          };
        }

        if (req.category === 'voice') {
          return {
            providerKey: 'elevenlabs',
            content:     Buffer.from('fake-audio-mp3-bytes'),
            contentUrl:  undefined,
            rawResponse: null,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 100, costUsd: 0.018 },
            latencyMs: 2000,
            usedFallback: false,
          };
        }

        throw new Error(`Unexpected category: ${req.category}`);
      });

      // Mock Telegram CDN storage
      mockTelegramStorage.enqueueUpload = jest.fn().mockResolvedValue({
        telegramFileId: 'tg-BQACAgIAAxk',
        cdnUrl: 'https://t.me/cdn/video.mp4',
      });
    });

    it('completes all pipeline stages and writes virality scores to DB', async () => {
      const result = await orchestrator.execute(JOB_ID, makeInput());

      expect(result.jobId).toBe(JOB_ID);
      expect(result.status).toBe('completed');
      expect(result.viralityScore).toBe(72);
      expect(result.predictedCtr).toBe(0.022);

      // Script + scene images + video clips + voice = at least 4 route calls
      expect(mockUserAiRouter.route.mock.calls.length).toBeGreaterThanOrEqual(4);

      // Virality scoring was called
      expect(mockCreativeScoring.scoreVideo).toHaveBeenCalled();

      // Final DB update contains virality score
      const finalUpdate = mockDb.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('virality_score'),
      );
      expect(finalUpdate).toBeDefined();
    });

    it('stores the assembled video via TelegramStorageFacade', async () => {
      await orchestrator.execute(JOB_ID, makeInput());
      expect(mockTelegramStorage.enqueueUpload).toHaveBeenCalled();
    });
  });
});
