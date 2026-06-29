import { CapitalGrowthEngine } from '../capital-growth.service';
import { EmpireLimitsService } from '../limits.service';
import { LongtermStrategyService } from '../longterm-strategy.service';
import { ReinvestService } from '../reinvest.service';
import { GlobalPerformanceService } from '../performance.service';

describe('core/empire phase1 coverage', () => {
  const pool = () => ({ query: jest.fn() });

  it('compounds reinvested capital and tolerates a failed growth event write', async () => {
    const pg = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const engine = new CapitalGrowthEngine(pg as any);

    await expect(engine.optimize(1000, { reinvested: 250, reserved: 50 } as any)).resolves.toBe(1250);
    await expect(engine.optimize(1000, { reinvested: 0, reserved: 50 } as any)).resolves.toBe(1000);
  });

  it('enforces capital and store limits from configuration', async () => {
    const config = { get: jest.fn((key: string, fallback: number) => ({ EMPIRE_MAX_STORES: 2, EMPIRE_MAX_EXPOSURE_INR: 500, EMPIRE_SEED_CAPITAL_INR: 1000, EMPIRE_LOSS_THRESHOLD_PCT: 20 } as any)[key] ?? fallback) };
    const limits = new EmpireLimitsService(config as any);

    await expect(limits.canAddStore(2)).resolves.toBe(false);
    await expect(limits.checkExposure(501)).resolves.toBe(false);
    await expect(limits.checkCapitalGuard(700)).resolves.toEqual({ halted: true, reason: 'Loss 30.0% exceeds threshold 20%' });
    await expect(limits.checkCapitalGuard(900)).resolves.toEqual({ halted: false });
  });

  it('honors manual strategy overrides and computes automatic strategy mode', async () => {
    const redis = { get: jest.fn().mockResolvedValueOnce('aggressive').mockResolvedValueOnce(null), set: jest.fn(), del: jest.fn() };
    const strategy = new LongtermStrategyService(redis as any);

    await expect(strategy.determineMode({ growthRate: 0, winRate: 0, totalCapital: 1 })).resolves.toBe('aggressive');
    await expect(strategy.determineMode({ growthRate: 11, winRate: 61, totalCapital: 60000 })).resolves.toBe('aggressive');
    expect(redis.set).toHaveBeenCalledWith('empire:strategy:mode', 'aggressive');
  });

  it('allocates profit by strategy and refuses to reinvest losses', async () => {
    const service = new ReinvestService();

    await expect(service.allocate(1000, 'aggressive')).resolves.toEqual(expect.objectContaining({ winnersScaling: 600, newStores: 250, reserve: 150, reinvested: 850 }));
    await expect(service.allocate(1000, 'conservative')).resolves.toEqual(expect.objectContaining({ winnersScaling: 400, newStores: 100, reserve: 500, reinvested: 500 }));
    await expect(service.allocate(-25, 'aggressive')).resolves.toEqual(expect.objectContaining({ reinvested: 0, reserved: 0 }));
  });

  it('builds snapshots from database metrics and falls back to an empty snapshot on database failure', async () => {
    const pg = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ capital: '1000', profit: '250', revenue: '1000' }] })
        .mockResolvedValueOnce({ rows: [{ actual: '2.5', predicted: '2.0' }] })
        .mockResolvedValueOnce({ rows: [{ cnt: '4' }] })
        .mockResolvedValueOnce({ rows: [{ wins: '7', losses: '3', total: '10' }] })
        .mockResolvedValueOnce({ rows: [{ capital_after: '1000' }, { capital_after: '900' }] })
        .mockRejectedValueOnce(new Error('offline')),
    };
    const service = new GlobalPerformanceService(pg as any);

    await expect(service.getSnapshot()).resolves.toEqual(expect.objectContaining({
      totalCapital: '1000',
      roi: 25,
      growthRate: expect.closeTo(11.111, 2),
      winRate: 70,
      roasDelta: 0.5,
      activeStores: 4,
    }));
    await expect(service.getSnapshot()).resolves.toEqual(expect.objectContaining({ totalCapital: 0, totalProfit: 0 }));
  });
});
