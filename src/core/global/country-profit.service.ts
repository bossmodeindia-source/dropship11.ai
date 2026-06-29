/**
 * CountryProfitService — V55 Country Profit Engine
 *
 * Calculates per-country profit:
 *
 *   profit = revenue_localized - ads_cost_region - shipping_region - product_cost
 *
 * Uses:
 *   - RegionService   for logistics + demand multiplier
 *   - CurrencyService for INR localization
 *
 * READ-ONLY. No execution. No Meta API calls.
 */

import { Injectable, Logger } from '@nestjs/common';
import { RegionService }   from './region.service';
import { CurrencyService } from './currency.service';

export interface CountryProfitInput {
  base_revenue_inr:      number;  // Revenue at baseline (India) in INR
  base_ads_cost_inr:     number;  // Ads cost in INR
  product_cost_inr:      number;  // Product/COGS in INR
  price_multiplier?:     number;  // Override demand-driven price scaling
}

export interface CountryProfitResult {
  country_code:     string;
  country_name:     string;
  currency_code:    string;
  revenue_local:    number;
  ads_cost_local:   number;
  shipping_local:   number;
  product_cost_local: number;
  profit_local:     number;
  profit_inr:       number;
  profit_usd:       number;
  margin_pct:       number;
  demand_multiplier: number;
}

@Injectable()
export class CountryProfitService {
  private readonly logger = new Logger(CountryProfitService.name);

  constructor(
    private readonly region:   RegionService,
    private readonly currency: CurrencyService,
  ) {}

  calculateForCountry(
    countryCode: string,
    input:       CountryProfitInput,
  ): CountryProfitResult | null {
    const profile = this.region.getCountry(countryCode);
    if (!profile) return null;

    const cc      = profile.currency_code as string;
    const dm      = input.price_multiplier ?? profile.demand_multiplier;
    const logistics = profile.logistics;

    // Scale revenue by demand multiplier + convert to local currency
    const revenue_inr   = input.base_revenue_inr * dm;
    const revenue_local = this.currency.convert(revenue_inr, 'INR', cc as any);

    // Ads cost scales with demand (more expensive in competitive markets)
    const ads_inr   = input.base_ads_cost_inr * (dm * 0.8);
    const ads_local = this.currency.convert(ads_inr, 'INR', cc as any);

    // Shipping from local logistics profile
    const shipping_usd   = logistics.shipping_cost_usd;
    const shipping_local = this.currency.convert(shipping_usd, 'USD', cc as any);

    // Product cost in local currency
    const product_local = this.currency.convert(input.product_cost_inr, 'INR', cc as any);

    const profit_local = revenue_local - ads_local - shipping_local - product_local;
    const profit_inr   = this.currency.convert(profit_local, cc as any, 'INR');
    const profit_usd   = this.currency.convert(profit_local, cc as any, 'USD');
    const margin_pct   = revenue_local > 0 ? (profit_local / revenue_local) * 100 : 0;

    return {
      country_code:       profile.country_code,
      country_name:       profile.country_name,
      currency_code:      profile.currency_code,
      revenue_local,
      ads_cost_local:     ads_local,
      shipping_local,
      product_cost_local: product_local,
      profit_local,
      profit_inr,
      profit_usd,
      margin_pct:         Math.round(margin_pct * 100) / 100,
      demand_multiplier:  dm,
    };
  }

  calculateAll(input: CountryProfitInput): CountryProfitResult[] {
    return this.region.getAllCountries()
      .map(p => this.calculateForCountry(p.country_code, input))
      .filter((r): r is CountryProfitResult => r !== null)
      .sort((a, b) => b.profit_inr - a.profit_inr);
  }
}
