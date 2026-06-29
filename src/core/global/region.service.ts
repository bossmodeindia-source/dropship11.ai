/**
 * RegionService — V55 Global Region Engine
 *
 * Manages:
 *   - Countries with ISO codes
 *   - Local currencies
 *   - Demand multipliers per region
 *   - Logistics profiles (shipping cost, delivery days)
 *
 * READ-ONLY reference data + DB persistence.
 * No execution. No Meta API calls.
 */

import { Injectable, Logger } from '@nestjs/common';

export interface LogisticsProfile {
  shipping_cost_usd: number;
  avg_delivery_days: number;
  cod_available:     boolean;
  return_rate_pct:   number;
}

export interface CountryProfile {
  country_code:      string;   // ISO-3166 alpha-2
  country_name:      string;
  currency_code:     string;   // ISO-4217
  demand_multiplier: number;   // 1.0 = baseline (India)
  logistics:         LogisticsProfile;
  active:            boolean;
}

// Seeded reference data — extend via DB in production
const COUNTRY_PROFILES: CountryProfile[] = [
  {
    country_code: 'IN', country_name: 'India',
    currency_code: 'INR', demand_multiplier: 1.0,
    logistics: { shipping_cost_usd: 2.0, avg_delivery_days: 5, cod_available: true,  return_rate_pct: 12 },
    active: true,
  },
  {
    country_code: 'US', country_name: 'United States',
    currency_code: 'USD', demand_multiplier: 3.5,
    logistics: { shipping_cost_usd: 8.0, avg_delivery_days: 7, cod_available: false, return_rate_pct: 20 },
    active: true,
  },
  {
    country_code: 'GB', country_name: 'United Kingdom',
    currency_code: 'GBP', demand_multiplier: 2.8,
    logistics: { shipping_cost_usd: 7.0, avg_delivery_days: 8, cod_available: false, return_rate_pct: 18 },
    active: true,
  },
  {
    country_code: 'DE', country_name: 'Germany',
    currency_code: 'EUR', demand_multiplier: 2.5,
    logistics: { shipping_cost_usd: 6.5, avg_delivery_days: 9, cod_available: false, return_rate_pct: 22 },
    active: true,
  },
  {
    country_code: 'AE', country_name: 'UAE',
    currency_code: 'AED', demand_multiplier: 2.2,
    logistics: { shipping_cost_usd: 5.0, avg_delivery_days: 6, cod_available: true,  return_rate_pct: 8 },
    active: true,
  },
  {
    country_code: 'AU', country_name: 'Australia',
    currency_code: 'AUD', demand_multiplier: 2.0,
    logistics: { shipping_cost_usd: 9.0, avg_delivery_days: 10, cod_available: false, return_rate_pct: 15 },
    active: true,
  },
  {
    country_code: 'CA', country_name: 'Canada',
    currency_code: 'CAD', demand_multiplier: 2.3,
    logistics: { shipping_cost_usd: 8.5, avg_delivery_days: 9, cod_available: false, return_rate_pct: 17 },
    active: true,
  },
  {
    country_code: 'SG', country_name: 'Singapore',
    currency_code: 'SGD', demand_multiplier: 1.8,
    logistics: { shipping_cost_usd: 4.0, avg_delivery_days: 5, cod_available: false, return_rate_pct: 10 },
    active: true,
  },
];

@Injectable()
export class RegionService {
  private readonly logger = new Logger(RegionService.name);
  private readonly profiles = new Map<string, CountryProfile>(
    COUNTRY_PROFILES.map(p => [p.country_code, p]),
  );

  getAllCountries(): CountryProfile[] {
    return Array.from(this.profiles.values()).filter(p => p.active);
  }

  getCountry(countryCode: string): CountryProfile | undefined {
    return this.profiles.get(countryCode.toUpperCase());
  }

  getLogistics(countryCode: string): LogisticsProfile | undefined {
    return this.profiles.get(countryCode.toUpperCase())?.logistics;
  }

  getDemandMultiplier(countryCode: string): number {
    return this.profiles.get(countryCode.toUpperCase())?.demand_multiplier ?? 1.0;
  }
}
