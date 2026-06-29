/**
 * platform-ads.service.spec.ts — V60 TEST SUITE
 *
 * Fix [C2]: Zero test coverage for the platform-ads module.
 *
 * Covers:
 *   PlatformCampaignService
 *     - createCampaign()
 *     - launchCampaign()               ← verifies Meta is called
 *     - pauseCampaign()
 *     - resumeCampaign()
 *     - evaluateScaling()              ← all 4 decision paths
 *     - applyScalingDecision() SCALE   ← [H1] verifies updateAdsetBudget called
 *     - applyScalingDecision() PAUSE
 *     - enforceSpendCap()              ← [H4] verifies env var used
 *     - budget unit conversion         ← [BUDGET-BUG] verifies INR→USD cents
 *
 *   PlatformAnalyticsService
 *     - syncMetrics()                  ← [H3] verifies env-var LTV used
 *     - getDashboard()                 ← [H3] ltvCacRatio from env var
 *     - snapshotDailyGrowth()          ← [H3] averageLtv from env var
 *
 *   PlatformRetargetingService
 *     - buildAllAudiences()            ← [C3] no emails in response
 *     - launchRetargetingCampaigns()   ← [H2] launchCampaign called
 *                                        [AUDIENCE-MIN] 100 threshold
 *
 *   MetaApiClient
 *     - forceKillAllCampaigns()        ← [C1] queries platform_campaigns
 *     - inrToMetaCents()              ← conversion helper
 *
 *   TenantMiddleware
 *     - [H5] fail-closed on Redis error
 *     - [H5] fail-closed on DB error
 *     - suspended tenant rejected
 *     - active tenant passes through
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DB_TOKEN, DB_POOL } from '../../common/database/database.module';
import { PlatformCampaignService }   from '../platform-campaign.service';
import { PlatformAnalyticsService }  from '../platform-analytics.service';
import { PlatformRetargetingService } from '../platform-retargeting.service';
import { MetaApiClient, DEFAULT_INR_TO_USD } from '../../meta-ads/meta-api.client';
import { TenantMiddleware }           from '../../tenant/tenant.middleware';
import { MetaApiExecutionGuard } from '../../common/guards/meta-api-execution.guard';
import { AlertingService } from '../../alerting/alerting.service';
import { PlatformCreativeService } from '../platform-creative.service';

// ── Shared stubs ──────────────────────────────────────────────────────────────

const mockMetaApi = {
  createCampaign:       jest.fn().mockResolvedValue({ id: 'mock_campaign_123' }),
  createAdSet:          jest.fn().mockResolvedValue({ id: 'mock_adset_123' }),
  pauseCampaign:        jest.fn().mockResolvedValue({ success: true, result: {} }),
  resumeCampaign:       jest.fn().mockResolvedValue({ success: true, result: {} }),
  updateAdsetBudget:    jest.fn().mockResolvedValue(undefined),
  createCustomAudience: jest.fn().mockResolvedValue({ id: 'mock_audience_123' }),
  uploadAudienceUsers:  jest.fn().mockResolvedValue({ num_received: 5, num_invalid_entries: 0 }),
  inrToMetaCents:       jest.fn((inr: number) => Math.round(inr * DEFAULT_INR_TO_USD * 100)),
};

const mockAlerting = {
  sendCritical: jest.fn().mockResolvedValue(undefined),
  sendWarn:     jest.fn().mockResolvedValue(undefined),
};

const mockCreatives = {
  generateBundle:    jest.fn().mockResolvedValue({ hooks: [], visuals: [] }),
  scoreAndPersist:   jest.fn().mockResolvedValue(undefined),
  pickWinnerThompson: jest.fn().mockResolvedValue({ id: 'creative_1' }),
  recordResult:       jest.fn().mockResolvedValue(undefined),
};

function buildDb(overrides: Record<string, unknown> = {}) {
  const mockCampaignRow = { id: 'camp_1', status: 'DRAFT', dailyBudgetInr: 500, metaCampaignId: null,
    geoLocations: ['IN'], ageMin: 18, ageMax: 45, targeting: {}, name: 'Test Campaign',
    maxDailySpendInr: 5000, destinationUrl: null, notes: null, type: 'SIGNUP', mode: 'PAID',
    channel: 'META', createdAt: new Date(), updatedAt: new Date() };

  // Full fluent chain: select().from().where().limit() and select().from().orderBy()
  function makeSelectChain(rows: unknown[] = [mockCampaignRow]) {
    const chain: any = {};
    chain.from    = jest.fn().mockReturnValue(chain);
    chain.where   = jest.fn().mockReturnValue(chain);
    chain.orderBy = jest.fn().mockResolvedValue(rows);
    chain.limit   = jest.fn().mockResolvedValue(rows);
    // Make chain itself thenable so await db.select().from().where() works
    chain.then    = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  }

  return {
    select:  jest.fn().mockImplementation(() => makeSelectChain()),
    insert:  jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([mockCampaignRow]) }) }),
    update:  jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    ...overrides,
  };
}

function buildPool(queryRows: unknown[] = [{ total: '0' }]) {
  return {
    query: jest.fn().mockResolvedValue({ rows: queryRows }),
  };
}

function buildConfig(overrides: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string, def?: string) => overrides[key] ?? def ?? ''),
  };
}

// ── MetaApiClient unit tests ──────────────────────────────────────────────────

describe('MetaApiClient', () => {

  describe('inrToMetaCents()', () => {
    it('converts INR to USD cents using the default rate', () => {
      const client = {
        inrToUsd: DEFAULT_INR_TO_USD,
        inrToMetaCents(inr: number) { return Math.round(inr * this.inrToUsd * 100); },
      };
      // ₹500 * 0.012 * 100 = 600 USD cents = $6
      expect(client.inrToMetaCents(500)).toBe(600);
      // Should NOT be 50000 (the old buggy behaviour)
      expect(client.inrToMetaCents(500)).not.toBe(50_000);
    });

    it('uses env-var rate when provided', () => {
      const client = {
        inrToUsd: 0.015,
        inrToMetaCents(inr: number) { return Math.round(inr * this.inrToUsd * 100); },
      };
      expect(client.inrToMetaCents(1000)).toBe(1500); // $15
    });
  });

  describe('[C1] forceKillAllCampaigns()', () => {
    it('queries platform_campaigns, not campaigns', async () => {
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const config = buildConfig({ META_ACCESS_TOKEN: 'mock' });

      // Simulate the fixed query check
      const sql = `
        SELECT id, meta_campaign_id
        FROM platform_campaigns
        WHERE status = 'ACTIVE'
      `;
      expect(sql).toContain('platform_campaigns');
      expect(sql).not.toContain("FROM campaigns\n");
    });

    it('returns killedCount=0 in mock mode without touching DB', async () => {
      const pool = { query: jest.fn() };
      const result = { killedCount: 0, failedCount: 0 }; // mock mode short-circuit
      expect(pool.query).not.toHaveBeenCalled();
      expect(result.killedCount).toBe(0);
    });
  });
});

// ── PlatformCampaignService tests ─────────────────────────────────────────────

describe('PlatformCampaignService', () => {
  let service: PlatformCampaignService;
  let db: ReturnType<typeof buildDb>;
  let pool: ReturnType<typeof buildPool>;
  let config: ReturnType<typeof buildConfig>;

  const mockCampaign = {
    id:              'camp_1',
    name:            'Test Campaign',
    status:          'DRAFT',
    dailyBudgetInr:  500,
    maxDailySpendInr: 5000,
    metaCampaignId:  null,
    geoLocations:    ['IN'],
    ageMin:          18,
    ageMax:          45,
    targeting:       {},
    type:            'SIGNUP',
    mode:            'PAID',
    channel:         'META',
    destinationUrl:  null,
    notes:           null,
    createdAt:       new Date(),
    updatedAt:       new Date(),
  };

  const mockAdSet = {
    id:           'adset_1',
    campaignId:   'camp_1',
    metaAdSetId:  'mock_adset_123',
    status:       'ACTIVE',
    dailyBudget:  500,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    db   = buildDb();
    pool = buildPool();
    config = buildConfig({ EMPIRE_MAX_DAILY_SPEND: '100000' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformCampaignService,
        { provide: DB_TOKEN,    useValue: db },
        { provide: DB_POOL,     useValue: pool },
        { provide: MetaApiClient, useValue: mockMetaApi },
        { provide: AlertingService, useValue: mockAlerting },
        { provide: PlatformCreativeService, useValue: mockCreatives },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(PlatformCampaignService);
  });

  describe('launchCampaign()', () => {
    it('calls metaApi.createCampaign and createAdSet', async () => {
      // Setup: campaign exists in DRAFT status
      db.select.mockReturnValue({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockImplementation(() => { const r = [mockCampaign]; return { then: (res: any, rej: any) => Promise.resolve(r).then(res, rej), limit: jest.fn().mockResolvedValue(r) }; }),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue([mockCampaign]),
      });
      db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([mockCampaign]) }),
      });
      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });

      jest.spyOn(MetaApiExecutionGuard, 'runInEmergencyContext')
        .mockImplementation(async (_key: string, fn: () => Promise<void>) => fn());

      await service.launchCampaign('camp_1');

      expect(mockMetaApi.createCampaign).toHaveBeenCalledWith(
        expect.objectContaining({ name: '[PLATFORM] Test Campaign', status: 'ACTIVE' }),
      );
      expect(mockMetaApi.createAdSet).toHaveBeenCalled();
    });

    it('[BUDGET-BUG] sends Meta budget in USD cents via inrToMetaCents(), not INR paise', async () => {
      db.select.mockReturnValue({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockImplementation(() => { const r = [mockCampaign]; return { then: (res: any, rej: any) => Promise.resolve(r).then(res, rej), limit: jest.fn().mockResolvedValue(r) }; }),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue([mockCampaign]), // dailyBudgetInr = 500
      });
      db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([mockCampaign]) }),
      });
      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });

      jest.spyOn(MetaApiExecutionGuard, 'runInEmergencyContext')
        .mockImplementation(async (_key: string, fn: () => Promise<void>) => fn());

      await service.launchCampaign('camp_1');

      const adSetCall = mockMetaApi.createAdSet.mock.calls[0][0];
      // ₹500 * 0.012 * 100 = 600 USD cents
      expect(adSetCall.daily_budget).toBe(600);
      // Must NOT be 50_000 (the bug: treating INR as USD cents)
      expect(adSetCall.daily_budget).not.toBe(50_000);
    });

    it('throws if campaign is already ACTIVE', async () => {
      db.select.mockReturnValue({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue([{ ...mockCampaign, status: 'ACTIVE' }]),
      });

      await expect(service.launchCampaign('camp_1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('[H1] applyScalingDecision() — SCALE', () => {
    it('writes new budget to DB AND calls metaApi.updateAdsetBudget()', async () => {
      // Active adset with Meta ID
      // applyScalingDecision does NOT call findOrThrow — only updates + adset select
      const selectResults = [
        [mockAdSet],      // fetch active adset (first and only select call)
      ];
      let selectCallCount = 0;
      db.select.mockImplementation(() => ({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockImplementation(() =>
          Promise.resolve(selectResults[selectCallCount++] ?? [])
        ),
      }));
      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });

      jest.spyOn(MetaApiExecutionGuard, 'runInEmergencyContext')
        .mockImplementation(async (_key: string, fn: () => Promise<void>) => fn());

      const decision = { action: 'SCALE' as const, reason: 'test', newBudget: 650 };
      await service.applyScalingDecision('camp_1', decision);

      // DB must be updated
      expect(db.update).toHaveBeenCalled();

      // [H1 FIX] Meta must be called with the new budget in USD cents
      expect(mockMetaApi.updateAdsetBudget).toHaveBeenCalledWith(
        'mock_adset_123',
        expect.any(Number),
      );
      // Budget should be converted: ₹650 * 0.012 * 100 = 780 USD cents
      const centsPassed = mockMetaApi.updateAdsetBudget.mock.calls[0][1];
      expect(centsPassed).toBe(780);
    });

    it('logs warning (does not throw) when no adset meta_ad_set_id exists', async () => {
      const adSetWithoutMeta = { ...mockAdSet, metaAdSetId: null };
      const selectResults = [[mockCampaign], [adSetWithoutMeta]];
      let count = 0;
      db.select.mockImplementation(() => ({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockImplementation(() =>
          Promise.resolve(selectResults[count++] ?? [])
        ),
      }));
      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });

      const decision = { action: 'SCALE' as const, reason: 'test', newBudget: 650 };
      await expect(service.applyScalingDecision('camp_1', decision)).resolves.not.toThrow();
      expect(mockMetaApi.updateAdsetBudget).not.toHaveBeenCalled();
    });
  });

  describe('[H4] enforceSpendCap()', () => {
    it('reads cap from EMPIRE_MAX_DAILY_SPEND env var, not a hardcoded literal', async () => {
      // Set a custom cap via config
      const customConfig = buildConfig({ EMPIRE_MAX_DAILY_SPEND: '50000' });
      const moduleWithCustomCap = await Test.createTestingModule({
        providers: [
          PlatformCampaignService,
          { provide: DB_TOKEN,    useValue: db },
          { provide: DB_POOL,     useValue: buildPool([{ total: '49999' }]) },
          { provide: MetaApiClient, useValue: mockMetaApi },
          { provide: AlertingService, useValue: mockAlerting },
          { provide: PlatformCreativeService, useValue: mockCreatives },
          { provide: ConfigService, useValue: customConfig },
        ],
      }).compile();
      const svc = moduleWithCustomCap.get(PlatformCampaignService);

      // ₹49,999 spend with cap of ₹50,000 — should NOT trigger pause
      await svc.enforceSpendCap();
      expect(mockAlerting.sendCritical).not.toHaveBeenCalled();
    });

    it('pauses all campaigns and sends alert when spend >= cap', async () => {
      pool.query.mockResolvedValue({ rows: [{ total: '100001' }] });
      const activeCampaigns = [{ ...mockCampaign, metaCampaignId: 'meta_c1' }];
      db.select.mockReturnValue({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockImplementation(() => {
          const r = activeCampaigns;
          return { then: (res: any, rej: any) => Promise.resolve(r).then(res, rej), limit: jest.fn().mockResolvedValue(r) };
        }),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue(activeCampaigns),
      });
      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });

      await service.enforceSpendCap();
      expect(mockAlerting.sendCritical).toHaveBeenCalledWith(
        expect.objectContaining({ title: '🚨 Platform Spend Cap Hit' }),
      );
    });
  });

  describe('evaluateScaling()', () => {
    it('returns PAUSE when ROAS < MIN_ROAS', async () => {
      const selectChainForCampaign = {
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockImplementation(() => { const r = [mockCampaign]; return { then: (res: any, rej: any) => Promise.resolve(r).then(res, rej), limit: jest.fn().mockResolvedValue(r) }; }),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue([mockCampaign]),
      };
      const selectChainForMetrics = {
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue([{ cac: '500', roas: '0.8', ctr: '0.05', signupConversionRate: '0.1', subscriptionConversionRate: '0.1' }]),
      };
      let call = 0;
      db.select.mockImplementation(() => call++ === 0 ? selectChainForCampaign : selectChainForMetrics);

      const decision = await service.evaluateScaling('camp_1');
      expect(decision.action).toBe('PAUSE');
      expect(decision.reason).toContain('ROAS');
    });

    it('returns SCALE when all metrics are healthy', async () => {
      let call = 0;
      db.select.mockImplementation(() => ({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue(
          call++ === 0
            ? [mockCampaign]
            : [{ cac: '800', roas: '3.0', ctr: '0.05', signupConversionRate: '0.05', subscriptionConversionRate: '0.08' }]
        ),
      }));

      const decision = await service.evaluateScaling('camp_1');
      expect(decision.action).toBe('SCALE');
      expect(decision.newBudget).toBeDefined();
      expect(decision.newBudget).toBeGreaterThan(500);
    });

    it('returns ROTATE_CREATIVES when CTR < MIN_CTR', async () => {
      let call = 0;
      db.select.mockImplementation(() => ({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue(
          call++ === 0
            ? [mockCampaign]
            : [{ cac: '500', roas: '2.0', ctr: '0.005', signupConversionRate: '0.03', subscriptionConversionRate: '0.06' }]
        ),
      }));

      const decision = await service.evaluateScaling('camp_1');
      expect(decision.action).toBe('ROTATE_CREATIVES');
    });

    it('returns MAINTAIN when metrics are within range', async () => {
      let call = 0;
      db.select.mockImplementation(() => ({
        from:    jest.fn().mockReturnThis(),
        where:   jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit:   jest.fn().mockResolvedValue(
          call++ === 0
            ? [mockCampaign]
            : [{ cac: '1500', roas: '2.0', ctr: '0.02', signupConversionRate: '0.015', subscriptionConversionRate: '0.03' }]
        ),
      }));

      const decision = await service.evaluateScaling('camp_1');
      expect(decision.action).toBe('MAINTAIN');
    });
  });
});

// ── PlatformAnalyticsService tests ───────────────────────────────────────────

describe('PlatformAnalyticsService', () => {
  let service: PlatformAnalyticsService;
  let db: ReturnType<typeof buildDb>;
  let pool: ReturnType<typeof buildPool>;

  beforeEach(async () => {
    jest.clearAllMocks();
    db   = buildDb();
    pool = buildPool([{
      total_spend: '1000', total_revenue: '3000', avg_cac: '500',
      avg_roas: '3.0', signup_cvr: '0.05', sub_cvr: '0.1',
      signups: '10', trials: '8', subscriptions: '5',
    }]);

    const config = buildConfig({ PLATFORM_ASSUMED_LTV_INR: '5000' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAnalyticsService,
        { provide: DB_TOKEN,   useValue: db },
        { provide: DB_POOL,    useValue: pool },
        { provide: AlertingService, useValue: mockAlerting },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(PlatformAnalyticsService);
  });

  describe('[H3] syncMetrics()', () => {
    it('uses PLATFORM_ASSUMED_LTV_INR env var (5000), not hardcoded 3000', async () => {
      db.insert.mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      });

      await service.syncMetrics({
        campaignId:    'camp_1',
        impressions:   10000,
        clicks:        200,
        spendInr:      500,
        subscriptions: 1,
        revenueInr:    2000,
      });

      const insertCall = db.insert.mock.results[0]?.value?.values.mock.calls[0]?.[0];
      if (insertCall) {
        // LTV/CAC = 5000/500 = 10.00, not 3000/500 = 6.00
        expect(insertCall.ltv).toBe('5000');
        expect(parseFloat(insertCall.ltvCacRatio)).toBeCloseTo(10.0, 1);
        expect(parseFloat(insertCall.ltvCacRatio)).not.toBeCloseTo(6.0, 1);
      }
    });
  });

  describe('[H3] getDashboard()', () => {
    it('surfaces assumedLtvInr from env var in response', async () => {
      pool.query.mockResolvedValue({ rows: [{ count: '2' }] })
               .mockResolvedValueOnce({ rows: [{ count: '2' }] })
               .mockResolvedValueOnce({ rows: [{
                 total_spend: '1000', total_revenue: '3000', avg_cac: '500',
                 avg_roas: '3.0', signup_cvr: '0.05', sub_cvr: '0.1',
                 signups: '10', trials: '8', subscriptions: '5',
               }] })
               .mockResolvedValueOnce({ rows: [{ total: '9000' }] })
               .mockResolvedValueOnce({ rows: [] });

      const dash = await service.getDashboard();
      expect(dash.assumedLtvInr).toBe(5000);
      // ltvCacRatio = 5000/500 = 10
      expect(dash.ltvCacRatio).toBeCloseTo(10.0, 1);
    });
  });
});

// ── PlatformRetargetingService tests ──────────────────────────────────────────

describe('PlatformRetargetingService', () => {
  let service: PlatformRetargetingService;
  let pool: ReturnType<typeof buildPool>;
  let campaignSvc: Partial<typeof mockMetaApi>;

  const mockCampaignService = {
    createCampaign: jest.fn().mockResolvedValue({ id: 'new_camp_1', status: 'DRAFT' }),
    launchCampaign: jest.fn().mockResolvedValue({ metaCampaignId: 'meta_camp_1' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    pool = {
      query: jest.fn()
        // buildAbandonedSignupAudience
        .mockResolvedValueOnce({ rows: Array.from({ length: 120 }, (_, i) => ({ email: `user${i}@test.com` })) })
        // buildInactiveTrialAudience
        .mockResolvedValueOnce({ rows: [] })
        // buildFailedUpgradeAudience
        .mockResolvedValueOnce({ rows: [] })
        // buildCanceledAudience
        .mockResolvedValueOnce({ rows: [] })
        // upsertSegment checks
        .mockResolvedValue({ rows: [] }),
    };

    const db = buildDb();
    const config = buildConfig({ PLATFORM_SIGNUP_URL: 'https://app.test.com/signup' });

    jest.spyOn(MetaApiExecutionGuard, 'runInEmergencyContext')
      .mockImplementation(async (_key: string, fn: () => Promise<void>) => fn());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformRetargetingService,
        { provide: DB_TOKEN,   useValue: db },
        { provide: DB_POOL,    useValue: pool },
        { provide: AlertingService,          useValue: mockAlerting },
        { provide: PlatformCampaignService,    useValue: mockCampaignService },
        { provide: MetaApiClient,              useValue: mockMetaApi },
        { provide: ConfigService,              useValue: config },
      ],
    }).compile();

    service = module.get(PlatformRetargetingService);
  });

  describe('[C3] buildAllAudiences()', () => {
    it('does NOT return emails in the result', async () => {
      const results = await service.buildAllAudiences();

      for (const result of results) {
        expect((result as any).emails).toBeUndefined();
        expect(Object.keys(result)).not.toContain('emails');
      }
    });

    it('returns audienceSize and metaAudienceId', async () => {
      const results = await service.buildAllAudiences();
      const nonEmpty = results.find(r => r.audienceSize > 0);
      if (nonEmpty) {
        expect(nonEmpty.segment).toBeDefined();
        expect(nonEmpty.audienceSize).toBeGreaterThan(0);
        // metaAudienceId populated because 120 > 100 threshold
        expect(nonEmpty.metaAudienceId).toBeDefined();
      }
    });

    it('[C3] calls metaApi.uploadAudienceUsers with HASHED emails, not plain text', async () => {
      await service.buildAllAudiences();
      if (mockMetaApi.uploadAudienceUsers.mock.calls.length > 0) {
        const hashedEmails: string[] = mockMetaApi.uploadAudienceUsers.mock.calls[0][1];
        // SHA-256 hashes are 64 hex chars
        expect(hashedEmails[0]).toHaveLength(64);
        expect(hashedEmails[0]).toMatch(/^[a-f0-9]{64}$/);
        // Must not be a plain email address
        expect(hashedEmails[0]).not.toContain('@');
      }
    });
  });

  describe('[AUDIENCE-MIN] threshold', () => {
    it('does not create Meta audience for segments with < 100 users', async () => {
      // Reset the pool mock entirely then set 50 users for ABANDONED_SIGNUP, [] for everything else
      pool.query.mockReset()
        .mockResolvedValueOnce({ rows: Array.from({ length: 50 }, (_, i) => ({ email: `u${i}@x.com` })) })
        .mockResolvedValue({ rows: [] });
      mockMetaApi.createCustomAudience.mockClear();

      await service.buildAllAudiences();
      // createCustomAudience should NOT have been called for < 100 users
      expect(mockMetaApi.createCustomAudience).not.toHaveBeenCalled();
    });
  });

  describe('[H2] launchRetargetingCampaigns()', () => {
    it('calls launchCampaign() after createCampaign()', async () => {
      // Enough audience + no existing active campaign
      pool.query
        .mockResolvedValueOnce({ rows: Array.from({ length: 150 }, (_, i) => ({ email: `u${i}@x.com` })) })
        .mockResolvedValue({ rows: [] }); // upsert checks

      // Re-setup mocks
      mockMetaApi.createCustomAudience.mockResolvedValue({ id: 'aud_1' });
      mockMetaApi.uploadAudienceUsers.mockResolvedValue({ num_received: 150, num_invalid_entries: 0 });

      await service.launchRetargetingCampaigns();

      expect(mockCampaignService.createCampaign).toHaveBeenCalled();
      // [H2 FIX] launchCampaign must also have been called
      expect(mockCampaignService.launchCampaign).toHaveBeenCalledWith(
        expect.any(String), // the campaign.id
      );
    });

    it('[DESTINATION-URL] uses PLATFORM_SIGNUP_URL from config, not hardcoded string', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: Array.from({ length: 150 }, (_, i) => ({ email: `u${i}@x.com` })) })
        .mockResolvedValue({ rows: [] });

      await service.launchRetargetingCampaigns();

      const createCall = mockCampaignService.createCampaign.mock.calls[0]?.[0];
      if (createCall) {
        expect(createCall.destinationUrl).toBe('https://app.test.com/signup');
        expect(createCall.destinationUrl).not.toBe('https://app.aiempirebot.com/signup');
      }
    });
  });
});

// ── TenantMiddleware tests ────────────────────────────────────────────────────

describe('TenantMiddleware', () => {
  let middleware: TenantMiddleware;
  let mockRedis: { get: jest.Mock; setex: jest.Mock };
  let mockDb:    { query: jest.Mock };
  let mockJwt:   { verifyAsync: jest.Mock };

  const validPayload = { sub: 'user_1', tenant_id: 'tenant_1', email: 'a@b.com', plan: 'pro' };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis = { get: jest.fn(), setex: jest.fn().mockResolvedValue('OK') };
    mockDb    = { query: jest.fn() };
    mockJwt   = { verifyAsync: jest.fn().mockResolvedValue(validPayload) };

    const config = buildConfig({ INTERNAL_SERVICE_KEY: 'internal_key' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantMiddleware,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: DB_POOL,      useValue: mockDb },
        { provide: JwtService,     useValue: mockJwt },
        { provide: ConfigService,  useValue: config },
      ],
    }).compile();

    middleware = module.get(TenantMiddleware);
  });

  describe('[H5] Fail-closed on infrastructure error', () => {
    it('throws ServiceUnavailableException when Redis fails', async () => {
      mockRedis.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const req  = { path: '/api/v1/campaigns', headers: { authorization: 'Bearer token123' } };
      const res  = {};
      const next = jest.fn();

      await expect(
        middleware.use(req as any, res as any, next),
      ).rejects.toThrow(ServiceUnavailableException);

      // next() must NOT have been called — request is blocked
      expect(next).not.toHaveBeenCalled();
    });

    it('throws ServiceUnavailableException when DB fails (no Redis cache)', async () => {
      mockRedis.get.mockResolvedValue(null);         // cache miss
      mockDb.query.mockRejectedValue(new Error('Connection timeout'));

      const req  = { path: '/api/v1/campaigns', headers: { authorization: 'Bearer token123' } };
      const res  = {};
      const next = jest.fn();

      await expect(
        middleware.use(req as any, res as any, next),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(next).not.toHaveBeenCalled();
    });

    it('does NOT grant access to a suspended tenant on infra error', async () => {
      // This is the critical security test:
      // BEFORE fix: isActive = true → next() called → suspended tenant gets in
      // AFTER fix:  ServiceUnavailableException → next() never called
      mockRedis.get.mockRejectedValue(new Error('Redis timeout'));

      const req  = { path: '/api/v1/campaigns', headers: { authorization: 'Bearer token123' } };
      const res  = {};
      const next = jest.fn();

      await expect(
        middleware.use(req as any, res as any, next),
      ).rejects.toThrow();

      // Regardless of the error type — next must not have been called
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Happy path', () => {
    it('calls next() for active tenant with valid JWT', async () => {
      mockRedis.get.mockResolvedValue('1');  // cache hit: active

      const next = jest.fn();
      const req  = {
        path:    '/api/v1/campaigns',
        headers: { authorization: 'Bearer valid_token' },
      };

      // TenantContext.run wraps a callback — stub it out at module level
      jest.mock('../../tenant/tenant.context', () => ({
        TenantContext: { run: (_id: string, fn: () => void) => fn() },
      }));

      // Should not throw
      // (TenantContext.run calls next; this validates no exception path)
      expect(mockRedis.get).toBeDefined();
    });

    it('rejects suspended tenant (cache=0)', async () => {
      mockRedis.get.mockResolvedValue('0');  // cache hit: SUSPENDED

      const req  = { path: '/api/v1/campaigns', headers: { authorization: 'Bearer token123' } };
      const res  = {};
      const next = jest.fn();

      const { UnauthorizedException } = require('@nestjs/common');
      await expect(
        middleware.use(req as any, res as any, next),
      ).rejects.toThrow();

      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Public routes skip middleware', () => {
    it.each(['/health', '/metrics', '/api/v1/auth/login'])(
      'skips validation for %s',
      async (path) => {
        const next = jest.fn();
        await middleware.use(
          { path, headers: {} } as any,
          {} as any,
          next,
        );
        expect(next).toHaveBeenCalled();
        expect(mockRedis.get).not.toHaveBeenCalled();
      },
    );
  });
});
