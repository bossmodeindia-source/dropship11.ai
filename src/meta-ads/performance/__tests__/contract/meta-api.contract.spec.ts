/**
 * FIX 7: Contract Tests — Meta Ads API
 *
 * Simulate real API responses:
 *  - Rate limits (429)
 *  - Partial / malformed data
 *  - Timeouts
 *  - Successful insights response
 *
 * These tests use jest.spyOn(global, 'fetch') to intercept HTTP calls.
 * No real network traffic is made.
 */

import { MetaPerformanceService } from '../../meta-performance.service';
import { ConfigService } from '@nestjs/config';

// ── Factory ───────────────────────────────────────────────────────────────────

function makeService(token = 'real-token-not-mock'): {
  service: MetaPerformanceService;
  dbMock:  jest.Mocked<any>;
} {
  const dbMock = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
        and:   jest.fn(),
      }),
    }),
  };

  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      const vals: Record<string, unknown> = {
        META_ACCESS_TOKEN:   token,
        ROAS_SCALE_THRESHOLD: 2,
        META_ASSUMED_AOV:     50,
      };
      return vals[key] ?? def;
    }),
  } as unknown as ConfigService;

  const service = new MetaPerformanceService(dbMock as any, config);
  return { service, dbMock };
}

function mockFetch(response: {
  status:  number;
  body:    unknown;
  delay?:  number;
}): void {
  jest.spyOn(global, 'fetch').mockImplementation(async () => {
    if (response.delay) {
      await new Promise((r) => setTimeout(r, response.delay));
    }
    return {
      ok:   response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Meta Insights API — Contract Tests', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  // ── Success path ──────────────────────────────────────────────────────────

  it('should parse a valid Meta Insights response', async () => {
    mockFetch({
      status: 200,
      body: {
        data: [{
          impressions: '10000',
          clicks:      '250',
          spend:       '150.00',
          actions: [
            { action_type: 'link_click',    value: '250' },
            { action_type: 'purchase',       value: '12'  },
          ],
        }],
      },
    });

    const { service } = makeService();
    const metrics     = await service.fetchMetrics('campaign-123');

    expect(metrics.impressions).toBe(10000);
    expect(metrics.clicks).toBe(250);
    expect(metrics.spend).toBe(150);
    expect(metrics.conversions).toBe(12);
    // CTR = 250/10000 * 100 = 2.5
    expect(metrics.ctr).toBe(2.5);
    // CPC = 150/250 = 0.6
    expect(metrics.cpc).toBe(0.6);
    // ROAS = (12 × 50) / 150 = 4
    expect(metrics.roas).toBe(4);
  });

  it('should handle response with no actions (zero conversions)', async () => {
    mockFetch({
      status: 200,
      body: { data: [{ impressions: '5000', clicks: '100', spend: '80.00' }] },
    });
    const { service } = makeService();
    const metrics     = await service.fetchMetrics('campaign-no-conversions');

    expect(metrics.conversions).toBe(0);
    expect(metrics.roas).toBe(0);
  });

  it('should handle empty data array (campaign just launched)', async () => {
    mockFetch({ status: 200, body: { data: [] } });
    const { service } = makeService();
    const metrics     = await service.fetchMetrics('new-campaign');

    // Should return neutral/cached metrics, NOT crash
    expect(metrics.campaignId).toBe('new-campaign');
    expect(metrics.roas).toBeGreaterThanOrEqual(0);
  });

  // ── Rate limit (429) ──────────────────────────────────────────────────────

  it('RATE LIMIT: should fall back gracefully on 429', async () => {
    mockFetch({
      status: 429,
      body:   { error: { message: 'User request limit reached', code: 17 } },
    });

    const { service } = makeService();
    // Should NOT throw — should return neutral metrics
    const metrics = await service.fetchMetrics('campaign-rate-limited');
    expect(metrics).toBeDefined();
    expect(metrics.campaignId).toBe('campaign-rate-limited');
  });

  it('RATE LIMIT: should return cached metrics on 429 if previously fetched', async () => {
    // First call succeeds and populates cache
    mockFetch({
      status: 200,
      body: { data: [{ impressions: '8000', clicks: '200', spend: '100', actions: [{ action_type: 'purchase', value: '5' }] }] },
    });
    const { service } = makeService();
    const first = await service.fetchMetrics('cached-campaign');
    expect(first.impressions).toBe(8000);

    // Second call hits 429 — should return the cached first result
    mockFetch({ status: 429, body: { error: 'rate limited' } });
    const second = await service.fetchMetrics('cached-campaign');
    expect(second.impressions).toBe(8000);   // cached value returned
  });

  // ── Server error (500) ────────────────────────────────────────────────────

  it('SERVER ERROR: should not throw on 500 from Meta API', async () => {
    mockFetch({ status: 500, body: { error: 'Internal Server Error' } });
    const { service } = makeService();
    await expect(service.fetchMetrics('campaign-500')).resolves.toBeDefined();
  });

  // ── Network timeout ───────────────────────────────────────────────────────

  it('TIMEOUT: should not throw when fetch rejects (network timeout)', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );
    const { service } = makeService();
    await expect(service.fetchMetrics('campaign-timeout')).resolves.toBeDefined();
  });

  // ── Malformed response ────────────────────────────────────────────────────

  it('MALFORMED: should not throw on response with missing fields', async () => {
    mockFetch({ status: 200, body: { data: [{}] } });  // all fields missing
    const { service } = makeService();
    const metrics     = await service.fetchMetrics('malformed-campaign');

    expect(metrics.impressions).toBe(0);
    expect(metrics.clicks).toBe(0);
    expect(metrics.spend).toBe(0);
    expect(metrics.ctr).toBe(0);
  });

  it('MALFORMED: should not throw on null data', async () => {
    mockFetch({ status: 200, body: { data: null } });
    const { service } = makeService();
    await expect(service.fetchMetrics('null-data')).resolves.toBeDefined();
  });

  // ── Evaluation guards ─────────────────────────────────────────────────────

  it('should NOT pause a campaign when fallback to neutral metrics (avoids false pauses)', async () => {
    // API returns 429 → neutral metrics returned → should be "break_even" or better
    mockFetch({ status: 429, body: {} });
    const { service } = makeService();
    const metrics     = await service.fetchMetrics('precious-campaign');
    const decision    = service.evaluatePerformance(metrics);

    // Neutral fallback has roas=1.0 → break_even → monitor (NOT pause)
    expect(decision.action).not.toBe('pause');
  });

  // ── ROAS thresholds ───────────────────────────────────────────────────────

  it('should scale budget when ROAS > threshold', async () => {
    mockFetch({
      status: 200,
      body: { data: [{
        impressions: '10000', clicks: '500', spend: '100',
        actions: [{ action_type: 'purchase', value: '10' }],
      }]},
    });
    const { service } = makeService();
    const metrics     = await service.fetchMetrics('profitable-campaign');
    // ROAS = (10 × 50) / 100 = 5 (above threshold of 2)
    const decision    = service.evaluatePerformance(metrics);
    expect(decision.action).toBe('scale_budget');
    expect(decision.budgetMultiplier).toBe(1.30);
  });

  it('should pause when ROAS < 1 (loss)', async () => {
    mockFetch({
      status: 200,
      body: { data: [{
        impressions: '1000', clicks: '10', spend: '500',
        actions: [{ action_type: 'purchase', value: '1' }],
      }]},
    });
    const { service } = makeService();
    const metrics     = await service.fetchMetrics('losing-campaign');
    // ROAS = (1 × 50) / 500 = 0.1 (below 1 → loss)
    const decision    = service.evaluatePerformance(metrics);
    expect(decision.action).toBe('pause');
    expect(decision.profitability).toBe('loss');
  });
});
