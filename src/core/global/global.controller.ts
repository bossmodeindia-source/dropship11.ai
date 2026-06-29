/**
 * GlobalController — V55
 *
 * Endpoints:
 *   GET /global/countries   — all active country profiles
 *   GET /global/performance — country-level profit performance
 *   GET /global/profit      — per-country profit for a given product/niche
 *
 * All endpoints are READ-ONLY. No execution.
 */

import { Controller, Get, Query, Logger } from '@nestjs/common';
import { RegionService }          from './region.service';
import { CountryProfitService }   from './country-profit.service';
import { CountrySelectorService } from './country-selector.service';
import { CurrencyService }        from './currency.service';

@Controller('global')
export class GlobalController {
  private readonly logger = new Logger(GlobalController.name);

  constructor(
    private readonly region:          RegionService,
    private readonly countryProfit:   CountryProfitService,
    private readonly countrySelector: CountrySelectorService,
    private readonly currency:        CurrencyService,
  ) {}

  @Get('countries')
  getCountries() {
    return {
      countries:    this.region.getAllCountries(),
      rates:        this.currency.getAllRates(),
      rates_as_of:  this.currency.getLastUpdated(),
    };
  }

  @Get('performance')
  getPerformance(
    @Query('revenue_inr')    revenueInr    = '5000',
    @Query('ads_cost_inr')   adsCostInr    = '1500',
    @Query('product_cost_inr') productCostInr = '800',
    @Query('niche')          niche         = 'general',
  ) {
    const input = {
      base_revenue_inr:  parseFloat(revenueInr),
      base_ads_cost_inr: parseFloat(adsCostInr),
      product_cost_inr:  parseFloat(productCostInr),
    };

    const results  = this.countryProfit.calculateAll(input);
    const top3     = results.slice(0, 3);
    const totalUsd = results.reduce((s, r) => s + r.profit_usd, 0);

    return { niche, top3, all: results, total_potential_usd: totalUsd };
  }

  @Get('profit')
  getProfit(
    @Query('country')        country       = 'IN',
    @Query('revenue_inr')    revenueInr    = '5000',
    @Query('ads_cost_inr')   adsCostInr    = '1500',
    @Query('product_cost_inr') productCostInr = '800',
  ) {
    const result = this.countryProfit.calculateForCountry(country.toUpperCase(), {
      base_revenue_inr:  parseFloat(revenueInr),
      base_ads_cost_inr: parseFloat(adsCostInr),
      product_cost_inr:  parseFloat(productCostInr),
    });

    if (!result) {
      return { error: `Country ${country} not found` };
    }

    return result;
  }
}
