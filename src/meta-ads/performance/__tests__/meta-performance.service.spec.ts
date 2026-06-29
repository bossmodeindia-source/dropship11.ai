import { Test, TestingModule } from '@nestjs/testing';
import {
  MetaPerformanceService,
  CampaignMetrics,
  PerformanceDecision,
} from '../meta-performance.service';
import { DB_TOKEN } from '../../../common/database/database.module';
import { ConfigService } from '@nestjs/config';

// ── Minimal Drizzle mock ─────────────────────────────────────────────────────
// Every chained call returns `this` so the builder pattern resolves.
const dbWhere    = jest.fn().mockResolvedValue([]);
const dbSet      = jest.fn().mockReturnValue({ where: dbWhere });
const dbUpdate   = jest.fn().mockReturnValue({ set: dbSet });
const dbFrom     = jest.fn().mockReturnValue({ where: dbWhere });
const dbSelect   = jest.fn().mockReturnValue({ from: dbFrom });

const mockDb = {
  update: dbUpdate,
  select: dbSelect,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<CampaignMetrics> = {}): CampaignMetrics {
  return {
    campaignId:  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    impressions: 10_000,
    clicks:      150,
    ctr:         1.5,
    cpc:         2.0,
    conversions: 10,
    roas:        1.5,
    spend:       300,
    ...overrides,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('MetaPerformanceService', () => {
  let service: MetaPerformanceService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetaPerformanceService,
        { provide: DB_TOKEN, useValue: mockDb },
        { provide: ConfigService, useValue: { get: jest.fn((_key: string, fallback?: unknown) => fallback) } },
      ],
    }).compile();

    service = module.get(MetaPerformanceService);
  });

  // ── evaluatePerformance ────────────────────────────────────────────────────

  describe('evaluatePerformance – CTR classification', () => {
    it('CTR < 1 % → ctrStatus = poor', () => {
      const d = service.evaluatePerformance(makeMetrics({ ctr: 0.5 }));
      expect(d.ctrStatus).toBe('poor');
    });

    it('CTR = 1 % exactly → ctrStatus = average', () => {
      const d = service.evaluatePerformance(makeMetrics({ ctr: 1.0 }));
      expect(d.ctrStatus).toBe('average');
    });

    it('CTR 1–2 % → ctrStatus = average', () => {
      const d = service.evaluatePerformance(makeMetrics({ ctr: 1.8 }));
      expect(d.ctrStatus).toBe('average');
    });

    it('CTR = 2 % exactly → ctrStatus = average', () => {
      const d = service.evaluatePerformance(makeMetrics({ ctr: 2.0 }));
      expect(d.ctrStatus).toBe('average');
    });

    it('CTR > 2 % → ctrStatus = good', () => {
      const d = service.evaluatePerformance(makeMetrics({ ctr: 3.5 }));
      expect(d.ctrStatus).toBe('good');
    });
  });

  describe('evaluatePerformance – ROAS / profitability', () => {
    it('ROAS > 2 → profitable', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 2.1 }));
      expect(d.profitability).toBe('profitable');
    });

    it('ROAS = 2 exactly → break_even (not profitable)', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 2.0 }));
      expect(d.profitability).toBe('break_even');
    });

    it('ROAS 1–2 → break_even', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 1.5 }));
      expect(d.profitability).toBe('break_even');
    });

    it('ROAS = 1 exactly → break_even', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 1.0 }));
      expect(d.profitability).toBe('break_even');
    });

    it('ROAS < 1 → loss', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 0.5 }));
      expect(d.profitability).toBe('loss');
    });

    it('ROAS = 0 → loss', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 0 }));
      expect(d.profitability).toBe('loss');
    });
  });

  describe('evaluatePerformance – scaling actions', () => {
    it('profitable → scale_budget with 1.30 multiplier', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 3.0 }));
      expect(d.action).toBe('scale_budget');
      expect(d.budgetMultiplier).toBe(1.30);
      expect(d.performanceStatus).toBe('profitable');
    });

    it('loss → pause with 0 multiplier', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 0.5 }));
      expect(d.action).toBe('pause');
      expect(d.budgetMultiplier).toBe(0);
      expect(d.performanceStatus).toBe('loss');
    });

    it('break_even → monitor with 1.00 multiplier', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 1.5 }));
      expect(d.action).toBe('monitor');
      expect(d.budgetMultiplier).toBe(1.00);
    });

    it('break_even performanceStatus falls back to ctrStatus', () => {
      const d = service.evaluatePerformance(makeMetrics({ roas: 1.2, ctr: 2.5 }));
      expect(d.performanceStatus).toBe('good');
    });
  });

  // ── fetchMetrics ───────────────────────────────────────────────────────────

  describe('fetchMetrics', () => {
    it('returns CampaignMetrics with correct campaignId', async () => {
      const m = await service.fetchMetrics('test-id-1234');
      expect(m.campaignId).toBe('test-id-1234');
    });

    it('returns positive impressions and non-negative numeric fields', async () => {
      const m = await service.fetchMetrics('test-id-abcd');
      expect(m.impressions).toBeGreaterThan(0);
      expect(m.clicks).toBeGreaterThanOrEqual(0);
      expect(m.ctr).toBeGreaterThanOrEqual(0);
      expect(m.roas).toBeGreaterThanOrEqual(0);
      expect(m.spend).toBeGreaterThan(0);
    });

    it('does not persist synthetic metrics in mock mode', async () => {
      await service.fetchMetrics('test-id-xyz');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('same campaignId produces same metrics (deterministic seed)', async () => {
      const a = await service.fetchMetrics('stable-id-999');
      jest.clearAllMocks();
      // re-create service to reset state
      const m2 = await Test.createTestingModule({
        providers: [
          MetaPerformanceService,
          { provide: DB_TOKEN, useValue: mockDb },
          { provide: ConfigService, useValue: { get: jest.fn((_key: string, fallback?: unknown) => fallback) } },
        ],
      })
        .compile()
        .then((m) => m.get(MetaPerformanceService).fetchMetrics('stable-id-999'));

      expect(a.impressions).toBe(m2.impressions);
      expect(a.ctr).toBe(m2.ctr);
    });
  });

  // ── applyScaling ───────────────────────────────────────────────────────────

  describe('applyScaling', () => {
    it('pause action sets campaign status to paused in DB', async () => {
      const decision = service.evaluatePerformance(makeMetrics({ roas: 0.3 }));
      await service.applyScaling(decision);
      expect(dbUpdate).toHaveBeenCalled();
      const setCall = dbSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.status).toBe('paused');
    });

    it('scale_budget action updates budgetDaily in DB', async () => {
      // DB select returns a row with budgetDaily
      dbWhere.mockResolvedValueOnce([{ budgetDaily: '200.00' }]);
      dbWhere.mockResolvedValueOnce([]);

      const decision = service.evaluatePerformance(makeMetrics({ roas: 3.0 }));
      await service.applyScaling(decision);

      // Second update call should set budgetDaily to 260.00 (200 * 1.30)
      const calls = dbSet.mock.calls;
      const scalingCall = calls.find(
        (c: Array<Record<string, unknown>>) =>
          typeof c[0]?.budgetDaily === 'string',
      );
      expect(scalingCall).toBeDefined();
      expect(parseFloat((scalingCall as Array<Record<string, string>>)[0].budgetDaily)).toBeCloseTo(260, 0);
    });

    it('does not throw on DB error — catches and logs only', async () => {
      dbWhere.mockRejectedValueOnce(new Error('DB down'));
      const decision: PerformanceDecision = {
        metrics:           makeMetrics({ roas: 0.1 }),
        ctrStatus:         'poor',
        profitability:     'loss',
        performanceStatus: 'loss',
        action:            'pause',
        budgetMultiplier:  0,
      };
      await expect(service.applyScaling(decision)).resolves.not.toThrow();
    });
  });

  // ── runFullCycle ───────────────────────────────────────────────────────────

  describe('runFullCycle', () => {
    it('returns { processed: 0, errors: 0 } when no campaigns found', async () => {
      dbWhere.mockResolvedValueOnce([]);
      const result = await service.runFullCycle();
      expect(result).toEqual({ processed: 0, errors: 0 });
    });

    it('never throws even when DB completely fails', async () => {
      mockDb.select = jest.fn().mockImplementation(() => {
        throw new Error('fatal DB error');
      });
      await expect(service.runFullCycle()).resolves.not.toThrow();
      // restore
      mockDb.select = dbSelect;
    });
  });
});
