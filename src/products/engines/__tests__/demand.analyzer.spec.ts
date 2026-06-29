import { DemandAnalyzer } from '../demand.analyzer';

describe('DemandAnalyzer', () => {
  let analyzer: DemandAnalyzer;

  beforeEach(() => {
    analyzer = new DemandAnalyzer();
  });

  describe('analyze()', () => {
    it('returns baseline 50 demand score with no signals', () => {
      const result = analyzer.analyze({});
      expect(result.demandScore).toBe(50);
    });

    it('returns 50 competition score with no competitorCount', () => {
      const result = analyzer.analyze({});
      expect(result.competitionScore).toBe(50);
    });

    it('boosts demand score for high search volume', () => {
      const low  = analyzer.analyze({ searchVolume: 500 });
      const high = analyzer.analyze({ searchVolume: 200_000 });
      expect(high.demandScore).toBeGreaterThan(low.demandScore);
    });

    it('penalises demand score for low search volume', () => {
      const baseline = analyzer.analyze({});
      const low      = analyzer.analyze({ searchVolume: 100 });
      expect(low.demandScore).toBeLessThan(baseline.demandScore);
    });

    it('returns high competition score (low competition) for few competitors', () => {
      const result = analyzer.analyze({ competitorCount: 5 });
      expect(result.competitionScore).toBe(90);
    });

    it('returns low competition score (saturated) for many competitors', () => {
      const result = analyzer.analyze({ competitorCount: 10_000 });
      expect(result.competitionScore).toBe(10);
    });

    it('incorporates trend index into demand score', () => {
      const low  = analyzer.analyze({ trendIndex: 10 });
      const high = analyzer.analyze({ trendIndex: 90 });
      expect(high.demandScore).toBeGreaterThan(low.demandScore);
    });

    it('clamps demand score to [0, 100]', () => {
      const result = analyzer.analyze({
        searchVolume: 0,
        reviewCount: 0,
        averageRating: 1,
        salesRank: 1_000_000,
        trendIndex: 0,
        competitorCount: 100_000,
      });
      expect(result.demandScore).toBeGreaterThanOrEqual(0);
      expect(result.demandScore).toBeLessThanOrEqual(100);
    });
  });
});
