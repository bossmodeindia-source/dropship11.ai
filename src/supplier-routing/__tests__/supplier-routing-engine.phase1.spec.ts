import { SupplierRoutingEngine, RoutingInput, SupplierCandidate } from '../supplier-routing-engine.service';

const candidate = (patch: Partial<SupplierCandidate>): SupplierCandidate => ({
  supplier: 'zendrop',
  productCost: 100,
  shippingCost: 20,
  estimatedDays: 5,
  reliabilityScore: 80,
  inStock: true,
  region: 'IN',
  ...patch,
});

const makeDb = (options: { override?: string | null; scores?: any[]; updatedRows?: any[] } = {}) => {
  const state = { inserts: [] as any[], updates: [] as any[] };
  const select = jest.fn(() => {
    const chain: any = {
      from: jest.fn(() => chain),
      where: jest.fn(() => chain),
      orderBy: jest.fn(() => Promise.resolve(options.scores ?? [])),
      limit: jest.fn(() => Promise.resolve(options.updatedRows ?? (options.override === undefined ? [] : [{ preferredSupplier: options.override }]))),
    };
    return chain;
  });
  const db: any = {
    select,
    insert: jest.fn(() => ({
      values: jest.fn((value: any) => {
        state.inserts.push(value);
        return Promise.resolve();
      }),
    })),
    update: jest.fn(() => {
      const chain: any = {
        set: jest.fn((value: any) => {
          state.updates.push(value);
          return chain;
        }),
        where: jest.fn(() => Promise.resolve()),
      };
      return chain;
    }),
    __state: state,
  };
  return db;
};

const input = (candidates: SupplierCandidate[]): RoutingInput => ({
  orderId: 'order-1',
  tenantId: 'tenant-1',
  productNiche: 'fitness',
  customerGeography: 'IN',
  quantity: 1,
  candidates,
});

describe('supplier-routing-engine phase1 coverage', () => {
  it('honors an in-stock admin override before ranking candidates', async () => {
    const db = makeDb({ override: 'aliexpress' });
    const service = new SupplierRoutingEngine(db, { learnFromOutcome: jest.fn() } as any, { incrementCounter: jest.fn() } as any);

    const result = await service.routeOrder(input([
      candidate({ supplier: 'zendrop', productCost: 80, reliabilityScore: 90 }),
      candidate({ supplier: 'aliexpress', productCost: 300, reliabilityScore: 50 }),
    ]));

    expect(result).toEqual(expect.objectContaining({ selected: 'aliexpress', reasoning: 'admin_override', landedCost: 320 }));
    expect(result.fallbacks).toEqual(['zendrop']);
  });

  it('filters by India coverage and selects the best ranked eligible supplier', async () => {
    const db = makeDb({ override: null });
    const service = new SupplierRoutingEngine(db, { learnFromOutcome: jest.fn() } as any, { incrementCounter: jest.fn() } as any);
    (service as any).reliabilityCache.set('cjdropshipping', 95);
    (service as any).reliabilityCache.set('custom', 100);

    const result = await service.routeOrder(input([
      candidate({ supplier: 'custom', productCost: 1, shippingCost: 1, estimatedDays: 1, reliabilityScore: 100 }),
      candidate({ supplier: 'cjdropshipping', productCost: 80, shippingCost: 20, estimatedDays: 4, reliabilityScore: 95 }),
      candidate({ supplier: 'alibaba', productCost: 300, shippingCost: 50, estimatedDays: 20, reliabilityScore: 40 }),
    ]));

    expect(result.selected).toBe('cjdropshipping');
    expect(result.fallbacks).toContain('alibaba');
    expect(result.fallbacks).not.toContain('custom');
  });

  it('falls back to any in-stock supplier and throws when every supplier is out of stock', async () => {
    const db = makeDb({ override: null });
    const service = new SupplierRoutingEngine(db, { learnFromOutcome: jest.fn() } as any, { incrementCounter: jest.fn() } as any);

    await expect(service.routeOrder(input([
      candidate({ supplier: 'custom', inStock: true, customerGeography: undefined } as any),
      candidate({ supplier: 'zendrop', inStock: false }),
    ]))).resolves.toEqual(expect.objectContaining({ selected: 'custom' }));

    await expect(service.routeOrder(input([
      candidate({ supplier: 'zendrop', inStock: false }),
      candidate({ supplier: 'aliexpress', inStock: false }),
    ]))).rejects.toThrow('No suppliers available');
  });

  it('records fulfillment outcomes to brain memory, supplier scores, metrics, and cache', async () => {
    const db = makeDb({ updatedRows: [{ currentScore: '70', totalOrders: 9, successfulOrders: 8 }] });
    const brain = { learnFromOutcome: jest.fn().mockResolvedValue(undefined) };
    const metrics = { incrementCounter: jest.fn() };
    const service = new SupplierRoutingEngine(db, brain as any, metrics as any);

    await service.recordFulfillmentOutcome('zendrop', true, 3, 'tenant-1');

    expect(brain.learnFromOutcome).toHaveBeenCalledWith(expect.objectContaining({
      category: 'supplier_reliability',
      tenantId: 'tenant-1',
      key: 'zendrop',
      successScore: 1,
    }));
    expect(db.__state.updates[0]).toEqual(expect.objectContaining({ totalOrders: 10, successfulOrders: 9 }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith('supplier_fulfillment_outcomes_total', { supplier: 'zendrop', result: 'success' });
    expect((service as any).reliabilityCache.get('zendrop')).toBe(91);
  });

  it('returns supplier rankings from stored scores', async () => {
    const db = makeDb({ scores: [{ supplier: 'zendrop', currentScore: '88.5', totalOrders: 10, successfulOrders: 9 }] });
    const service = new SupplierRoutingEngine(db, { learnFromOutcome: jest.fn() } as any, { incrementCounter: jest.fn() } as any);

    await expect(service.getSupplierRankings('tenant-1')).resolves.toEqual([{ supplier: 'zendrop', score: 88.5, totalOrders: 10, successRate: 0.9 }]);
  });
});
