import { ProfitService } from '../profit.service';

describe('ProfitService deprecated compatibility contract', () => {
  let service: ProfitService;

  beforeEach(() => {
    service = new ProfitService();
  });

  it('calculates revenue from order lines', () => {
    expect(service.calculateRevenue([
      { quantity: 2, unitPrice: 49.99 },
      { quantity: 1, unitPrice: 25.5 },
    ])).toBe(125.48);
  });

  it('returns zero revenue for no order lines', () => {
    expect(service.calculateRevenue([])).toBe(0);
  });

  it('calculates simple profit from revenue and costs', () => {
    expect(service.calculateProfit(500, 335)).toBe(165);
  });

  it('allows negative profit as a signal instead of throwing', () => {
    expect(service.calculateProfit(100, 175)).toBe(-75);
  });

  it('calculates ROAS and guards zero ad spend', () => {
    expect(service.calculateRoas(500, 100)).toBe(5);
    expect(service.calculateRoas(500, 0)).toBe(0);
  });
});
