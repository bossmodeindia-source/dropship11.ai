import { ErrorHandlerService } from '../ops/error-handler.service';
import { RetryQueueService } from '../ops/retry.queue';
import { CacheService } from '../ops/cache.service';
import { OpsLoggerService } from '../ops/logger.service';
import { RiskEngine } from '../reasoning/risk.engine';
import { ScenarioSimulatorService } from '../reasoning/scenario-simulator.service';
import { ReasoningEngine } from '../reasoning/reasoning.engine';
import { SupplierIntelligenceService, SupplierRecord } from '../supply/supplier-intelligence.service';
import { SupplierSelectorService } from '../supply/supplier-selector.service';

describe('core/ops phase1 coverage', () => {
  it('classifies and routes transient, critical, and unknown errors', async () => {
    const alert = { systemFailure: jest.fn().mockResolvedValue(undefined) };
    const mode = { isPaused: jest.fn().mockResolvedValue(false), pause: jest.fn().mockResolvedValue(undefined) };
    const retryQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const ops = { error: jest.fn() };
    const service = new ErrorHandlerService(alert as any, mode as any, retryQueue as any, ops as any);

    expect(service.classify(new Error('ECONNRESET from redis'))).toBe('transient');
    expect(service.classify(new Error('capital breach detected'))).toBe('critical');
    expect(service.classify(new Error('plain validation issue'))).toBe('unknown');

    await service.handleError(new Error('rate limit 503'), { service: 'Shopify', action: 'sync', attempt: 2, payload: { id: 1 } });
    await service.handleError(new Error('authentication failed'), { service: 'Meta', action: 'launch' });
    await service.handleError(new Error('unexpected'), { service: 'Worker', action: 'run' });

    expect(retryQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ service: 'Shopify', attempt: 3, originErr: 'rate limit 503' }), undefined);
    expect(alert.systemFailure).toHaveBeenCalledWith('Meta', 'authentication failed');
    expect(mode.pause).toHaveBeenCalledWith('Critical error in Meta: authentication failed');
    expect(retryQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ service: 'Worker', attempt: 1 }), 2);
  });

  it('uses Redis-backed cache operations and fails open on cache errors', async () => {
    const service = new CacheService({ get: jest.fn() } as any);
    const redis = {
      get: jest.fn().mockResolvedValueOnce(JSON.stringify({ ok: true })).mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(null),
      setex: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('down')),
      keys: jest.fn().mockResolvedValue(['cache:a', 'cache:b']),
    };
    (service as any).redis = redis;

    await expect(service.get('x')).resolves.toEqual({ ok: true });
    await expect(service.get('x')).resolves.toBeNull();
    await service.set('x', { value: 1 }, 12);
    await service.del('x');
    await expect(service.has('x')).resolves.toBe(true);
    await expect(service.has('x')).resolves.toBe(false);
    await expect(service.delByPrefix('a')).resolves.toBe(2);
    await expect(service.getOrSet('miss', async () => 'fresh', 7)).resolves.toBe('fresh');

    expect(redis.setex).toHaveBeenCalledWith('cache:x', 12, '{"value":1}');
    expect(redis.del).toHaveBeenCalledWith('cache:x');
    expect(redis.keys).toHaveBeenCalledWith('cache:a*');
  });

  it('enqueues retry jobs and returns queue stats', async () => {
    const service = new RetryQueueService({ get: jest.fn() } as any);
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getWaitingCount: jest.fn().mockResolvedValue(1),
      getActiveCount: jest.fn().mockResolvedValue(2),
      getFailedCount: jest.fn().mockResolvedValue(3),
      getCompletedCount: jest.fn().mockResolvedValue(4),
    };
    (service as any).queue = queue;

    await service.enqueue({ service: 'Meta', action: 'launch', payload: { a: 1 }, attempt: 1, originErr: '503' }, 9);
    await expect(service.getStats()).resolves.toEqual({ waiting: 1, active: 2, failed: 3, completed: 4 });
    expect(queue.add).toHaveBeenCalledWith('Meta:launch', expect.objectContaining({ originErr: '503' }), expect.objectContaining({ attempts: 9 }));
  });

  it('closes retry workers, queue, and Redis connection on shutdown', async () => {
    const service = new RetryQueueService({ get: jest.fn() } as any);
    const worker = { close: jest.fn().mockResolvedValue(undefined) };
    const queue = { close: jest.fn().mockResolvedValue(undefined) };
    const connection = { quit: jest.fn().mockResolvedValue('OK') };
    (service as any).workers.add(worker);
    (service as any).queue = queue;
    (service as any).connection = connection;

    await service.onModuleDestroy();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(connection.quit).toHaveBeenCalledTimes(1);
  });

  it('removes the cache listener and closes Redis on shutdown', async () => {
    const service = new CacheService({ get: jest.fn() } as any);
    const redis = {
      status: 'ready',
      removeListener: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    (service as any).redis = redis;

    await service.onModuleDestroy();

    expect(redis.removeListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('writes structured log entries to the proper stream', () => {
    const logger = new OpsLoggerService();
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logger.log('started', 'Empire', { cycle: 1 });
    logger.critical('halted', 'Empire');

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"level":"info"'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"level":"critical"'));
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe('core/reasoning phase1 coverage', () => {
  it('normalizes risk factors into a bounded risk score', () => {
    const result = new RiskEngine().calculate({ volatility: 6, capitalExposure: 1, pastFailures: 10, nicheStability: -1 });

    expect(result.risk_score).toBe(100);
    expect(result.volatility_weight).toBe(100);
    expect(result.exposure_weight).toBe(100);
    expect(result.failure_weight).toBe(100);
    expect(result.stability_weight).toBe(100);
  });

  it('simulates best, worst, average, expected profit and downside', () => {
    const result = new ScenarioSimulatorService().simulate({ roas: 2, confidence: 0.5 } as any, {} as any, 1000, 0.5);

    expect(result.best_case.revenue).toBe(1800);
    expect(result.worst_case.profit).toBe(-700);
    expect(result.expected_loss).toBe(700);
    expect(result.best_case.probability + result.worst_case.probability + result.average_case.probability).toBeCloseTo(1);
  });

  it('returns execute, hold, and reject decisions from actual risk and scenario inputs', async () => {
    const scenario = { simulate: jest.fn() };
    const risk = { calculate: jest.fn() };
    const financialAi = { computeProfit: jest.fn().mockResolvedValue({ profit: 0 }) };
    const service = new ReasoningEngine(scenario as any, risk as any, financialAi as any);
    const ctx = { testBudget: 100, capitalExposure: 0.1, volatility: 0.2, pastFailures: 0, nicheStability: 1 };

    risk.calculate.mockReturnValueOnce({ risk_score: 20 });
    scenario.simulate.mockReturnValueOnce({ expected_profit: 50, expected_loss: 0, best_case: { profit: 100 }, worst_case: { profit: 0 }, average_case: { profit: 50 } });
    await expect(service.simulate({ roas: 2, confidence: 0.8 } as any, ctx)).resolves.toEqual(expect.objectContaining({ decision: 'EXECUTE' }));

    risk.calculate.mockReturnValueOnce({ risk_score: 55 });
    scenario.simulate.mockReturnValueOnce({ expected_profit: 50, expected_loss: 0, best_case: { profit: 100 }, worst_case: { profit: 0 }, average_case: { profit: 50 } });
    await expect(service.simulate({ roas: 2, confidence: 0.8 } as any, ctx)).resolves.toEqual(expect.objectContaining({ decision: 'HOLD' }));

    risk.calculate.mockReturnValueOnce({ risk_score: 20 });
    scenario.simulate.mockReturnValueOnce({ expected_profit: -1, expected_loss: 20, best_case: { profit: 10 }, worst_case: { profit: -20 }, average_case: { profit: 0 } });
    await expect(service.simulate({ roas: 0.5, confidence: 0.9 } as any, ctx)).resolves.toEqual(expect.objectContaining({ decision: 'REJECT' }));
  });
});

describe('core/supply phase1 coverage', () => {
  const supplier = (patch: Partial<SupplierRecord>): SupplierRecord => ({
    id: 's1',
    name: 'Supplier One',
    contact_email: 's@example.com',
    categories: ['fitness'],
    country: 'IN',
    avg_delivery_days: 5,
    avg_cost_inr: 250,
    total_orders: 100,
    successful_orders: 90,
    active: true,
    ...patch,
  });

  it('scores suppliers and continues if score persistence fails', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('history offline')) };
    const service = new SupplierIntelligenceService(pool as any);

    const score = await service.scoreSupplier(supplier({}));

    expect(score).toEqual(expect.objectContaining({
      supplierId: 's1',
      reliability: 25,
      deliverySpeed: 22,
      costEfficiency: 25,
      successRate: 23,
      available: true,
    }));
  });

  it('loads category-filtered suppliers and scores all loaded suppliers', async () => {
    const rows = [supplier({ id: 's1' }), supplier({ id: 's2', active: false })];
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    const service = new SupplierIntelligenceService(pool as any);
    jest.spyOn(service as any, 'persistScore').mockResolvedValue(undefined);

    await expect(service.loadSuppliers('fitness')).resolves.toBe(rows);
    await expect(service.scoreAll()).resolves.toHaveLength(2);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('$1 = ANY(categories)'), ['fitness']);
  });

  it('selects the best available supplier, marks fallback, and returns null when none are available', async () => {
    const intelligence = {
      loadSuppliers: jest.fn()
        .mockResolvedValueOnce([supplier({ id: 'primary', active: false }), supplier({ id: 'fallback', name: 'Fallback' })])
        .mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      scoreSupplier: jest.fn(async (s: SupplierRecord) => ({
        supplierId: s.id,
        supplierName: s.name,
        total: s.id === 'primary' ? 90 : 80,
        reliability: 20,
        deliverySpeed: 20,
        costEfficiency: 20,
        successRate: 20,
        available: s.active,
        computedAt: new Date().toISOString(),
      })),
    };
    const service = new SupplierSelectorService(intelligence as any);

    await expect(service.selectSupplier({ category: 'fitness', product_id: 'p1' })).resolves.toEqual(expect.objectContaining({
      supplier: expect.objectContaining({ id: 'fallback' }),
      isFallback: true,
    }));
    await expect(service.selectSupplier({ category: 'missing', product_id: 'p2' })).resolves.toBeNull();
  });
});
