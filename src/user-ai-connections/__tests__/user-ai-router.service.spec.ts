/**
 * UserAiRouterService — unit tests
 *
 * Covers:
 *  - route()                 : happy-path via mocked decryptKeyForRuntime + HTTP call
 *  - route()                 : ForbiddenException when no provider is connected
 *  - route()                 : prefers specified preferred provider
 *  - route()                 : tries fallback candidate when first provider throws
 *  - route()                 : records usage asynchronously (fire-and-forget)
 *  - buildProviderCandidates : filters by category via DB query
 *  - markConnectionError     : sets connection_status=invalid_key on 401
 *
 * Real HTTP calls are never made — all provider methods are mocked via
 * jest.spyOn on the private method layer.
 */

import { Test, TestingModule }  from '@nestjs/testing';
import { ForbiddenException }   from '@nestjs/common';
import { UserAiRouterService, UserAiRequest } from '../user-ai-router.service';
import { UserAiConnectionsService } from '../user-ai-connections.service';
import { DB_POOL } from '../../common/database/database.module';

// ── fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID   = 'tenant-router-test';
const PROVIDER_KEY = 'openai';

const makeRequest = (overrides: Partial<UserAiRequest> = {}): UserAiRequest => ({
  tenantId:  TENANT_ID,
  category:  'reasoning',
  operation: 'script_generation',
  prompt:    'Write a 15-second TikTok script for an AI posture corrector',
  model:     'gpt-4o',
  ...overrides,
});

const makeSuccessResult = () => ({
  content:     'Generated script content here',
  contentUrl:  undefined,
  rawResponse: null,
  usage:       { promptTokens: 200, completionTokens: 400, totalTokens: 600, costUsd: 0.003 },
});

// ── mocks ────────────────────────────────────────────────────────────────────

const mockConnections = {
  decryptKeyForRuntime: jest.fn().mockResolvedValue({ apiKey: 'sk-fake', secondaryKey: null }),
  recordUsage:          jest.fn().mockResolvedValue(undefined),
};

const makeMockDb = (providerRows: unknown[] = []) => ({
  query: jest.fn().mockResolvedValue({ rows: providerRows, rowCount: providerRows.length }),
});

// ── helpers ───────────────────────────────────────────────────────────────────

const makeProviderRow = (overrides: Record<string, unknown> = {}) => ({
  id:                     'conn-uuid-1',
  provider_key:           PROVIDER_KEY,
  category:               'reasoning',
  allow_platform_fallback: false,
  connection_status:      'active',
  quota_used:             0,
  quota_limit:            null,
  total_requests:         0,
  created_at:             new Date(),
  ...overrides,
});

// ── suite ─────────────────────────────────────────────────────────────────────

describe('UserAiRouterService', () => {
  let service: UserAiRouterService;
  let dbMock:  ReturnType<typeof makeMockDb>;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserAiRouterService,
        { provide: DB_POOL,                             useValue: dbMock          },
        { provide: UserAiConnectionsService,            useValue: mockConnections },
      ],
    }).compile();

    service = module.get<UserAiRouterService>(UserAiRouterService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnections.decryptKeyForRuntime.mockResolvedValue({ apiKey: 'sk-fake', secondaryKey: null });
    mockConnections.recordUsage.mockResolvedValue(undefined);
  });

  // ── no provider connected ────────────────────────────────────────────────

  describe('route() — no provider connected', () => {
    it('throws ForbiddenException with helpful message', async () => {
      dbMock = makeMockDb([]); // no rows = no active connections
      await build();

      await expect(service.route(makeRequest()))
        .rejects.toBeInstanceOf(ForbiddenException);
    });

    it('error message references the missing category', async () => {
      dbMock = makeMockDb([]);
      await build();

      await expect(service.route(makeRequest({ category: 'video_generation' })))
        .rejects.toThrow(/video_generation/);
    });
  });

  // ── happy path ───────────────────────────────────────────────────────────

  describe('route() — happy path', () => {
    beforeEach(async () => {
      dbMock = makeMockDb([makeProviderRow()]);
      await build();

      // Stub the private callProvider method
      jest.spyOn(service as any, 'callProvider').mockResolvedValue(makeSuccessResult());
    });

    it('returns a UserAiResponse with providerKey and content', async () => {
      const resp = await service.route(makeRequest());

      expect(resp.providerKey).toBe(PROVIDER_KEY);
      expect(resp.content).toBe('Generated script content here');
      expect(resp.usedFallback).toBe(false);
    });

    it('includes latencyMs as a positive number', async () => {
      const resp = await service.route(makeRequest());
      expect(resp.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('calls recordUsage exactly once (fire-and-forget)', async () => {
      await service.route(makeRequest());

      // Allow the unresolved promise to settle
      await Promise.resolve();
      expect(mockConnections.recordUsage).toHaveBeenCalledTimes(1);
    });

    it('passes operation, campaignId, creativeId through to recordUsage', async () => {
      await service.route(makeRequest({ campaignId: 'camp-1', creativeId: 'cre-1' }));
      await Promise.resolve();

      expect(mockConnections.recordUsage).toHaveBeenCalledWith(
        TENANT_ID,
        PROVIDER_KEY,
        'script_generation',
        expect.objectContaining({ campaignId: 'camp-1', creativeId: 'cre-1' }),
      );
    });
  });

  // ── preferred provider ───────────────────────────────────────────────────

  describe('route() — preferred provider ordering', () => {
    it('moves the preferred provider to the front of the candidate list', async () => {
      dbMock = makeMockDb([
        makeProviderRow({ provider_key: 'openrouter', total_requests: 0 }),
        makeProviderRow({ provider_key: 'openai',     total_requests: 5 }),
      ]);
      await build();

      const callProviderSpy = jest
        .spyOn(service as any, 'callProvider')
        .mockResolvedValue(makeSuccessResult());

      await service.route(makeRequest({ preferredProvider: 'openai' }));

      // First argument to the first callProvider call should be the preferred key
      expect(callProviderSpy.mock.calls[0][0]).toBe('openai');
    });
  });

  // ── fallback candidate ───────────────────────────────────────────────────

  describe('route() — fallback to next candidate', () => {
    it('tries the second candidate when the first throws', async () => {
      dbMock = makeMockDb([
        makeProviderRow({ provider_key: 'openai',     total_requests: 0 }),
        makeProviderRow({ provider_key: 'openrouter', total_requests: 1 }),
      ]);
      await build();

      let callCount = 0;
      jest.spyOn(service as any, 'callProvider').mockImplementation(async (providerKey: string) => {
        callCount++;
        if (providerKey === 'openai') throw new Error('Rate limited');
        return makeSuccessResult();
      });

      mockConnections.decryptKeyForRuntime.mockResolvedValue({ apiKey: 'sk-any', secondaryKey: null });

      const resp = await service.route(makeRequest());
      expect(resp.providerKey).toBe('openrouter');
      expect(callCount).toBe(2);
    });

    it('throws the last error when all candidates fail', async () => {
      dbMock = makeMockDb([
        makeProviderRow({ provider_key: 'openai' }),
        makeProviderRow({ provider_key: 'claude' }),
      ]);
      await build();

      jest.spyOn(service as any, 'callProvider').mockRejectedValue(
        new Error('All providers down'),
      );

      await expect(service.route(makeRequest())).rejects.toThrow('All providers down');
    });
  });

  // ── markConnectionError (401 handling) ────────────────────────────────────

  describe('markConnectionError()', () => {
    it('sets connection_status to invalid_key when called', async () => {
      dbMock = makeMockDb([makeProviderRow()]);
      await build();

      await (service as any).markConnectionError(TENANT_ID, PROVIDER_KEY, 'invalid_key');

      // 'invalid_key' is passed as a query parameter, not embedded in the SQL string
      const updateCall = dbMock.query.mock.calls.find(
        ([_sql, params]: [string, unknown[]]) =>
          Array.isArray(params) && params.some(p => typeof p === 'string' && p.includes('invalid_key')),
      );
      expect(updateCall).toBeDefined();
    });
  });

  // ── quota filtering ───────────────────────────────────────────────────────

  describe('buildProviderCandidates() — quota filtering', () => {
    it('excludes providers with quota_used >= quota_limit from DB query', async () => {
      // The SQL WHERE clause handles this — we just verify the query includes the condition
      dbMock = makeMockDb([]);
      await build();

      await service.route(makeRequest()).catch(() => {}); // ignore ForbiddenException

      const [sql] = dbMock.query.mock.calls[0];
      expect(sql).toContain('quota_used < c.quota_limit');
    });
  });

  // ── image_generation category ─────────────────────────────────────────────

  describe('route() — image_generation returns contentUrl', () => {
    it('returns contentUrl (not content) for image category', async () => {
      dbMock = makeMockDb([makeProviderRow({ provider_key: 'flux', category: 'image_generation' })]);
      await build();

      jest.spyOn(service as any, 'callProvider').mockResolvedValue({
        content:    null,
        contentUrl: 'https://cdn.bfl.ai/generated.png',
        rawResponse: null,
        usage:      { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0.055 },
      });

      const resp = await service.route(makeRequest({
        category:          'image_generation',
        preferredProvider: 'flux',
      }));

      expect(resp.contentUrl).toBe('https://cdn.bfl.ai/generated.png');
      expect(resp.content).toBeNull();
    });
  });
});
