/**
 * CountrySelectorService — V55 Country Selection Logic
 *
 * Selects the best country for a niche based on:
 *   - demand          (demand_multiplier × trend)
 *   - competition     (inverse — lower = better)
 *   - cost            (logistics cost — lower = better)
 *   - delivery_feasibility (delivery days threshold)
 *
 * Scoring formula (0–100):
 *   score = W_DEMAND × demand_score
 *         + W_COMPETITION × competition_score
 *         + W_COST × cost_score
 *         + W_DELIVERY × delivery_score
 *
 * Returns ranked list. Auto-trigger signals if top country score > threshold.
 *
 * READ-ONLY. No execution. No Meta API calls.
 */

import { Injectable, Logger } from '@nestjs/common';
import { RegionService, CountryProfile } from './region.service';
import { CountryProfitService, CountryProfitInput } from './country-profit.service';

export interface CountrySelectionInput {
  niche:             string;
  profitInput:       CountryProfitInput;
  trend_score?:      number;  // 0–1 (from V46)
  competition_score?: number; // 0–1 (from V26, lower = less competition)
  max_delivery_days?: number;
}

export interface CountryScore {
  country_code:   string;
  country_name:   string;
  score:          number;
  profit_inr:     number;
  demand_score:   number;
  competition_score: number;
  cost_score:     number;
  delivery_score: number;
  feasible:       boolean;
  auto_expand:    boolean;  // true if score exceeds expansion threshold
}

// Weights
const W_DEMAND      = 0.35;
const W_COMPETITION = 0.25;
const W_COST        = 0.20;
const W_DELIVERY    = 0.20;

const MAX_SHIPPING_USD    = 12;
const MAX_DELIVERY_DAYS   = 14;
const AUTO_EXPAND_SCORE   = 70;

@Injectable()
export class CountrySelectorService {
  private readonly logger = new Logger(CountrySelectorService.name);

  constructor(
    private readonly region:        RegionService,
    private readonly countryProfit: CountryProfitService,
  ) {}

  selectBest(input: CountrySelectionInput): CountryScore[] {
    const countries   = this.region.getAllCountries();
    const maxDelivery = input.max_delivery_days ?? MAX_DELIVERY_DAYS;
    const trend       = input.trend_score       ?? 0.5;
    const competition = input.competition_score ?? 0.5;

    const scores: CountryScore[] = countries.map(profile => {
      return this.scoreCountry(profile, input, trend, competition, maxDelivery);
    });

    const ranked = scores.sort((a, b) => b.score - a.score);

    this.logger.log(
      `CountrySelector for niche=${input.niche}: top=${ranked[0]?.country_code} ` +
      `score=${ranked[0]?.score?.toFixed(1)}`,
    );

    return ranked;
  }

  getTopCountry(input: CountrySelectionInput): CountryScore | null {
    const ranked = this.selectBest(input);
    return ranked.find(c => c.feasible) ?? null;
  }

  getAutoExpandCandidates(input: CountrySelectionInput): CountryScore[] {
    return this.selectBest(input).filter(c => c.auto_expand && c.feasible);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private scoreCountry(
    profile:     CountryProfile,
    input:       CountrySelectionInput,
    trend:       number,
    competition: number,
    maxDelivery: number,
  ): CountryScore {
    const logistics = profile.logistics;

    const demand_score      = Math.min(profile.demand_multiplier * trend * 25, 100);
    const competition_score = (1 - competition) * 100;
    const cost_score        = Math.max(0, (1 - logistics.shipping_cost_usd / MAX_SHIPPING_USD)) * 100;
    const delivery_score    = Math.max(0, (1 - logistics.avg_delivery_days / maxDelivery)) * 100;

    const score = Math.round(
      W_DEMAND      * demand_score +
      W_COMPETITION * competition_score +
      W_COST        * cost_score +
      W_DELIVERY    * delivery_score,
    );

    const profitResult = this.countryProfit.calculateForCountry(
      profile.country_code, input.profitInput,
    );

    const profit_inr  = profitResult?.profit_inr ?? 0;
    const feasible    = logistics.avg_delivery_days <= maxDelivery && profit_inr > 0;
    const auto_expand = score >= AUTO_EXPAND_SCORE && feasible;

    return {
      country_code:      profile.country_code,
      country_name:      profile.country_name,
      score,
      profit_inr,
      demand_score,
      competition_score,
      cost_score,
      delivery_score,
      feasible,
      auto_expand,
    };
  }
}
