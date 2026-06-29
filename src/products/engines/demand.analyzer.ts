import { Injectable } from '@nestjs/common';

export interface DemandSignals {
  searchVolume?: number;       // monthly searches (0–1,000,000+)
  reviewCount?: number;        // product reviews on source platform
  averageRating?: number;      // 1-5
  salesRank?: number;          // lower = better (Amazon BSR style)
  competitorCount?: number;    // how many similar listings
  trendIndex?: number;         // 0-100 from trend API
}

export interface DemandResult {
  demandScore: number;         // 0-100
  competitionScore: number;    // 0-100 (higher = less competition = better)
  signals: DemandSignals;
}

@Injectable()
export class DemandAnalyzer {
  analyze(signals: DemandSignals): DemandResult {
    const demandScore = this.calcDemandScore(signals);
    const competitionScore = this.calcCompetitionScore(signals);
    return { demandScore, competitionScore, signals };
  }

  private calcDemandScore(s: DemandSignals): number {
    let score = 50; // baseline

    // Search volume contribution (max 30 pts)
    if (s.searchVolume !== undefined) {
      if (s.searchVolume > 100_000) score += 30;
      else if (s.searchVolume > 50_000) score += 22;
      else if (s.searchVolume > 10_000) score += 15;
      else if (s.searchVolume > 1_000) score += 8;
      else score -= 10;
    }

    // Reviews + rating contribution (max 20 pts)
    if (s.reviewCount !== undefined && s.averageRating !== undefined) {
      const reviewPts = Math.min(s.reviewCount / 500, 10);
      const ratingPts = ((s.averageRating - 1) / 4) * 10;
      score += reviewPts + ratingPts;
    }

    // Trend index contribution (max 20 pts)
    if (s.trendIndex !== undefined) {
      score += (s.trendIndex / 100) * 20 - 10;
    }

    // Sales rank: lower = better demand
    if (s.salesRank !== undefined) {
      if (s.salesRank < 1_000) score += 10;
      else if (s.salesRank < 10_000) score += 5;
      else if (s.salesRank > 500_000) score -= 10;
    }

    return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
  }

  private calcCompetitionScore(s: DemandSignals): number {
    // Higher score = lower competition = better
    if (s.competitorCount === undefined) return 50;

    if (s.competitorCount < 10) return 90;
    if (s.competitorCount < 50) return 75;
    if (s.competitorCount < 200) return 60;
    if (s.competitorCount < 1000) return 40;
    if (s.competitorCount < 5000) return 20;
    return 10;
  }
}
