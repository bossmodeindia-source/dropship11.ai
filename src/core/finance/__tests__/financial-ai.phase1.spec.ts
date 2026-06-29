import { FinancialAiService } from '../financial-ai.service';

describe('financial-ai.service phase1 coverage', () => {
  it('computes true profit, roas, and margin and persists positive income metadata', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new FinancialAiService(pool as any);

    const result = await service.computeProfit({
      revenue: 1000,
      adsCost: 250,
      productCost: 300,
      shipping: 100,
      fees: 50,
      productId: 'product-1',
      storeId: 'store-1',
      source: 'test',
    });

    expect(result).toEqual({ revenue: 1000, adsCost: 250, productCost: 300, shipping: 100, fees: 50, profit: 300, roas: 4, margin: 0.3 });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO finance_transactions'), [
      'income',
      300,
      'test',
      'product-1',
      'store-1',
      JSON.stringify(result),
    ]);
  });

  it('records negative profit as an expense and ignores persistence failures as non-critical', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db offline')) };
    const service = new FinancialAiService(pool as any);

    await expect(service.computeProfit({ revenue: 100, adsCost: 80, productCost: 70, shipping: 10, fees: 5 })).resolves.toEqual(expect.objectContaining({
      profit: -65,
      roas: 1.25,
      margin: -0.65,
    }));
  });

  it('builds global, store, and product summaries from finance rows', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ revenue: '1000', costs: '500' }] })
        .mockResolvedValueOnce({ rows: [{ store_id: 'store-a', revenue: '700', costs: '200' }, { store_id: 'store-b', revenue: '100', costs: '200' }] })
        .mockResolvedValueOnce({ rows: [{ product_id: 'product-a', revenue: '300', costs: '100' }] }),
    };
    const service = new FinancialAiService(pool as any);

    const summary = await service.getGlobalSummary();

    expect(summary.global).toEqual(expect.objectContaining({ revenue: 1000, profit: 500, roas: 4 }));
    expect(summary.byStore['store-a']).toEqual(expect.objectContaining({ profit: 500 }));
    expect(summary.byStore['store-b']).toEqual(expect.objectContaining({ profit: -100 }));
    expect(summary.byProduct['product-a']).toEqual(expect.objectContaining({ profit: 200 }));
    expect(new Date(summary.asOf).toString()).not.toBe('Invalid Date');
  });

  it('returns loss stores and profitable stores from store profitability', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ store_id: 'loss', revenue: '100', costs: '300' }, { store_id: 'scale', revenue: '1000', costs: '100' }] })
        .mockResolvedValueOnce({ rows: [{ store_id: 'loss', revenue: '100', costs: '300' }, { store_id: 'scale', revenue: '1000', costs: '100' }] }),
    };
    const service = new FinancialAiService(pool as any);

    await expect(service.getLossStores()).resolves.toEqual(['loss']);
    await expect(service.getProfitableStores(500)).resolves.toEqual(['scale']);
  });

  it('returns empty summaries when finance queries fail', async () => {
    const service = new FinancialAiService({ query: jest.fn().mockRejectedValue(new Error('db down')) } as any);

    await expect(service.getGlobalSummary()).resolves.toEqual(expect.objectContaining({
      global: { revenue: 0, adsCost: 0, productCost: 0, shipping: 0, fees: 0, profit: 0, roas: 0, margin: 0 },
      byStore: {},
      byProduct: {},
    }));
  });
});
