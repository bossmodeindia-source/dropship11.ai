/**
 * ProviderHealthMonitorService — unit tests
 *
 * Covers:
 *  - runHealthChecks() : skips when no approved providers
 *  - runHealthChecks() : fires check for each approved provider
 *  - checkProvider()   : marks healthy when endpoint responds within latency SLA
 *  - checkProvider()   : marks degraded when latency > 5000ms
 *  - checkProvider()   : marks down and fires alert when endpoint returns unexpected status
 *  - checkProvider()   : marks down and fires alert when fetch throws (network error)
 *  - checkProvider()   : assumes healthy when no health endpoint defined (unknown provider)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ProviderHealthMonitorService } from '../provider-health-monitor.service';
import { AiProviderRegistryService } from '../ai-provider-registry.service';
import { AlertingService } from '../../alerting/alerting.service';

// ── mocks ─────────────────────────────────────────────────────────────────────

const registryMock = {
  listApprovedProviders: jest.fn(),
  recordHealthSnapshot:  jest.fn().mockResolvedValue(undefined),
};

const alertingMock = {
  alertApiOutage: jest.fn().mockResolvedValue(undefined),
};

// ── global fetch mock ─────────────────────────────────────────────────────────

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

// ── helpers ───────────────────────────────────────────────────────────────────

const makeProvider = (providerKey: string, id = `prov-${providerKey}`) => ({
  id,
  providerKey,
  displayName: providerKey,
  status: 'approved' as const,
  category: 'reasoning',
  description: null,
  sdkClass: null,
  baseUrl: null,
  docsUrl: null,
  capabilities: {},
  pricingPerUnit: null,
  pricingUnit: null,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const makeFetchResponse = (status: number, latencyMs = 0) => ({
  status,
  ok: status >= 200 && status < 300,
});

// ── suite ──────────────────────────────────────────────────────────────────────

describe('ProviderHealthMonitorService', () => {
  let service: ProviderHealthMonitorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderHealthMonitorService,
        { provide: AiProviderRegistryService, useValue: registryMock },
        { provide: AlertingService,           useValue: alertingMock },
      ],
    })
      .overrideProvider(AiProviderRegistryService).useValue(registryMock)
      .overrideProvider(AlertingService).useValue(alertingMock)
      .compile();

    service = module.get<ProviderHealthMonitorService>(ProviderHealthMonitorService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── runHealthChecks ───────────────────────────────────────────────────────

  describe('runHealthChecks()', () => {
    it('is a no-op when there are no approved providers', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([]);
      await service.runHealthChecks();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(registryMock.recordHealthSnapshot).not.toHaveBeenCalled();
    });

    it('calls checkProvider for each approved provider', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([
        makeProvider('openai'),
        makeProvider('claude'),
      ]);

      fetchMock.mockResolvedValue(makeFetchResponse(200));

      await service.runHealthChecks();

      // 2 providers → 2 fetch calls
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  // ── checkProvider — healthy ───────────────────────────────────────────────

  describe('checkProvider() — healthy', () => {
    it('records healthy snapshot when openai status page returns 200 quickly', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([makeProvider('openai')]);
      fetchMock.mockResolvedValue(makeFetchResponse(200)); // 200 = expected

      await service.runHealthChecks();

      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledWith(
        'prov-openai',
        'healthy',
        expect.any(Number),
        undefined,
      );
      expect(alertingMock.alertApiOutage).not.toHaveBeenCalled();
    });

    it('records healthy snapshot for openrouter when endpoint returns 401 (expected)', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([makeProvider('openrouter')]);
      fetchMock.mockResolvedValue(makeFetchResponse(401)); // 401 = expected for openrouter

      await service.runHealthChecks();

      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledWith(
        'prov-openrouter',
        'healthy',
        expect.any(Number),
        undefined,
      );
    });
  });

  // ── checkProvider — degraded ──────────────────────────────────────────────

  describe('checkProvider() — degraded', () => {
    it('records degraded snapshot when latency > 5000ms', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([makeProvider('openai')]);

      // Simulate slow response by overriding Date.now
      let callCount = 0;
      const realDateNow = Date.now.bind(Date);
      jest.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        // First call: start time; second call: after fetch → simulate 6s elapsed
        return callCount === 1 ? 1_000_000 : 1_006_100;
      });

      fetchMock.mockResolvedValue(makeFetchResponse(200));

      await service.runHealthChecks();

      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledWith(
        'prov-openai',
        'degraded',
        expect.any(Number),
        undefined,
      );
      expect(alertingMock.alertApiOutage).not.toHaveBeenCalled();

      jest.restoreAllMocks();
    });
  });

  // ── checkProvider — down (bad status) ────────────────────────────────────

  describe('checkProvider() — down (unexpected HTTP status)', () => {
    it('records down snapshot and fires alert when endpoint returns 503', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([makeProvider('openai')]);
      fetchMock.mockResolvedValue(makeFetchResponse(503)); // 503 = down

      await service.runHealthChecks();

      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledWith(
        'prov-openai',
        'down',
        expect.any(Number),
        undefined,
      );
      expect(alertingMock.alertApiOutage).toHaveBeenCalledWith(
        'openai',
        expect.stringContaining('503'),
      );
    });
  });

  // ── checkProvider — down (network error) ─────────────────────────────────

  describe('checkProvider() — down (fetch throws)', () => {
    it('records down snapshot and fires alert on network error', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([makeProvider('claude')]);
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await service.runHealthChecks();

      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledWith(
        'prov-claude',
        'down',
        expect.any(Number),
        'ECONNREFUSED',
      );
      expect(alertingMock.alertApiOutage).toHaveBeenCalledWith(
        'claude',
        expect.stringContaining('ECONNREFUSED'),
      );
    });

    it('does NOT throw — all provider checks settle independently', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([
        makeProvider('openai'),
        makeProvider('claude'),
      ]);

      fetchMock
        .mockResolvedValueOnce(makeFetchResponse(200)) // openai → healthy
        .mockRejectedValueOnce(new Error('Timeout'));  // claude  → down

      // runHealthChecks must not throw even when one check fails
      await expect(service.runHealthChecks()).resolves.not.toThrow();

      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  // ── checkProvider — unknown provider key ─────────────────────────────────

  describe('checkProvider() — unknown provider (no health endpoint defined)', () => {
    it('assumes healthy without fetching anything', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([
        makeProvider('custom-llm-provider'),
      ]);

      await service.runHealthChecks();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(registryMock.recordHealthSnapshot).toHaveBeenCalledWith(
        'prov-custom-llm-provider',
        'healthy',
        null,
      );
    });
  });

  // ── alerting isolation ────────────────────────────────────────────────────

  describe('alerting isolation', () => {
    it('swallows alertApiOutage errors (alert channel failure must not block health loop)', async () => {
      registryMock.listApprovedProviders.mockResolvedValue([makeProvider('openai')]);
      fetchMock.mockResolvedValue(makeFetchResponse(503));
      alertingMock.alertApiOutage.mockRejectedValue(new Error('Slack API down'));

      // Must still settle without throwing
      await expect(service.runHealthChecks()).resolves.not.toThrow();
    });
  });
});
