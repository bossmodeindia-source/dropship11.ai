import { CurrencyService } from '../currency.service';
import { RegionService } from '../region.service';
import { CountryProfitService } from '../country-profit.service';
import { CountrySelectorService } from '../country-selector.service';

describe('core/global phase1 coverage', () => {
  it('converts through USD-relative rates without mutating the rates snapshot', () => {
    const service = new CurrencyService();
    const rates = service.getAllRates();

    expect(service.convert(83.5, 'INR', 'USD')).toBe(1);
    expect(service.toINR(1, 'USD')).toBe(83.5);
    expect(service.toUSD(83.5, 'INR')).toBe(1);
    expect(service.getRate('USD', 'EUR')).toBe(0.92);

    rates.USD = 99;
    expect(service.convert(1, 'USD', 'INR')).toBe(83.5);
    expect(new Date(service.getLastUpdated()).toString()).not.toBe('Invalid Date');
  });

  it('returns active country and logistics reference data case-insensitively', () => {
    const service = new RegionService();

    expect(service.getAllCountries()).toHaveLength(8);
    expect(service.getCountry('us')).toEqual(expect.objectContaining({ country_code: 'US', currency_code: 'USD' }));
    expect(service.getLogistics('ae')).toEqual(expect.objectContaining({ cod_available: true }));
    expect(service.getDemandMultiplier('unknown')).toBe(1);
  });

  it('calculates localized profit and sorts countries by INR profit', () => {
    const region = new RegionService();
    const currency = new CurrencyService();
    const service = new CountryProfitService(region, currency);
    const input = { base_revenue_inr: 1000, base_ads_cost_inr: 200, product_cost_inr: 300 };

    const us = service.calculateForCountry('US', input);
    const missing = service.calculateForCountry('ZZ', input);
    const all = service.calculateAll(input);

    expect(us).toEqual(expect.objectContaining({
      country_code: 'US',
      currency_code: 'USD',
      profit_inr: expect.any(Number),
      profit_usd: expect.any(Number),
      margin_pct: expect.any(Number),
    }));
    expect(missing).toBeNull();
    expect(all[0].profit_inr).toBeGreaterThanOrEqual(all[1].profit_inr);
  });

  it('ranks feasible countries and only flags profitable high-score auto expansion', () => {
    const region = new RegionService();
    const profit = {
      calculateForCountry: jest.fn((countryCode: string) => ({
        profit_inr: countryCode === 'US' ? 5000 : countryCode === 'IN' ? 1000 : -10,
      })),
    };
    const service = new CountrySelectorService(region, profit as any);
    const input = {
      niche: 'fitness',
      trend_score: 1,
      competition_score: 0.05,
      max_delivery_days: 10,
      profitInput: { base_revenue_inr: 2000, base_ads_cost_inr: 300, product_cost_inr: 500 },
    };

    const ranked = service.selectBest(input);
    const autoExpand = service.getAutoExpandCandidates(input);

    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(service.getTopCountry(input)).toEqual(expect.objectContaining({ feasible: true }));
    expect(autoExpand.every(c => c.feasible && c.auto_expand)).toBe(true);
  });
});
