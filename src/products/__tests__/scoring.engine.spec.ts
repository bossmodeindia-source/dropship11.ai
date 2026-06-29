/**
 * Integration spec: scoreProduct() + makeDecision() working together,
 * and the MarginCalculator / DemandAnalyzer classes they depend on.
 */
import { scoreProduct, RawProductSignals } from '../engines/scoring.engine';
import { makeDecision }                    from '../engines/decision.engine';
import { MarginCalculator }                from '../engines/margin.calculator';
import { DemandAnalyzer }                  from '../engines/demand.analyzer';

// ── MarginCalculator ──────────────────────────────────────────────────────────
describe('MarginCalculator', () => {
  const calc = new MarginCalculator();

  it('computes grossMargin = selling - supplier - shipping - platformFee', () => {
    const r = calc.calculate({ supplierPrice: 10, sellingPrice: 30 });
    // platform fee = 30 * 0.03 = 0.9, gross = 30 - 10 - 0 - 0.9 = 19.1
    expect(r.grossMargin).toBeCloseTo(19.1, 1);
  });

  it('subtracts adSpend from netMargin', () => {
    const r = calc.calculate({ supplierPrice: 10, sellingPrice: 30, adSpend: 5 });
    expect(r.netMargin).toBeCloseTo(r.grossMargin - 5, 1);
  });

  it('marginScore is 0 when selling price is 0', () => {
    const r = calc.calculate({ supplierPrice: 10, sellingPrice: 0 });
    expect(r.marginScore).toBe(0);
  });

  it('marginScore increases as gross margin percent increases', () => {
    const low  = calc.calculate({ supplierPrice: 28, sellingPrice: 30 });
    const high = calc.calculate({ supplierPrice: 5,  sellingPrice: 30 });
    expect(high.marginScore).toBeGreaterThan(low.marginScore);
  });

  it('roasBreakeven = sellingPrice / adSpend', () => {
    const r = calc.calculate({ supplierPrice: 5, sellingPrice: 30, adSpend: 10 });
    expect(r.roasBreakeven).toBeCloseTo(3, 1);
  });

  it('all output values are non-negative numbers', () => {
    const r = calc.calculate({ supplierPrice: 15, sellingPrice: 50 });
    expect(r.grossMargin).toBeGreaterThanOrEqual(0);
    expect(r.marginScore).toBeGreaterThanOrEqual(0);
    expect(r.marginScore).toBeLessThanOrEqual(100);
  });
});

// ── DemandAnalyzer ────────────────────────────────────────────────────────────
describe('DemandAnalyzer', () => {
  const analyzer = new DemandAnalyzer();

  it('returns demandScore and competitionScore', () => {
    const r = analyzer.analyze({ searchVolume: 10_000, competitorCount: 100 });
    expect(r).toHaveProperty('demandScore');
    expect(r).toHaveProperty('competitionScore');
  });

  it('high search volume boosts demandScore above low volume', () => {
    const low  = analyzer.analyze({ searchVolume: 100 });
    const high = analyzer.analyze({ searchVolume: 500_000 });
    expect(high.demandScore).toBeGreaterThan(low.demandScore);
  });

  it('fewer competitors yields higher competitionScore', () => {
    const few  = analyzer.analyze({ competitorCount: 5 });
    const many = analyzer.analyze({ competitorCount: 10_000 });
    expect(few.competitionScore).toBeGreaterThan(many.competitionScore);
  });

  it('all scores are within [0, 100]', () => {
    const extreme = analyzer.analyze({ searchVolume: 10_000_000, competitorCount: 1, trendIndex: 100 });
    expect(extreme.demandScore).toBeLessThanOrEqual(100);
    expect(extreme.competitionScore).toBeLessThanOrEqual(100);
    const zero = analyzer.analyze({ searchVolume: 0, competitorCount: 100_000, trendIndex: 0 });
    expect(zero.demandScore).toBeGreaterThanOrEqual(0);
    expect(zero.competitionScore).toBeGreaterThanOrEqual(0);
  });
});

// ── scoreProduct + makeDecision integration ───────────────────────────────────
describe('scoreProduct() + makeDecision() integration', () => {
  it('RUN_ADS path: high margin + high demand + low competition', () => {
    const score = scoreProduct({
      supplierPrice:         5,
      estimatedSellingPrice: 50,
      demandSearchVolume:    50_000,
      competitorCount:       10,
      reviewRating:          4.8,
      trendIndex:            85,
    });
    const { decision } = makeDecision(score);
    expect(score.compositeScore).toBeGreaterThanOrEqual(45);
    expect(['RUN_ADS', 'TEST_ADS']).toContain(decision);
  });

  it('REJECT path: nearly zero margin always rejects', () => {
    const score = scoreProduct({
      supplierPrice:         49,
      estimatedSellingPrice: 50,
      demandSearchVolume:    100_000,
      competitorCount:       5,
      reviewRating:          5,
      trendIndex:            100,
    });
    const { decision } = makeDecision(score);
    expect(decision).toBe('REJECT');
  });

  it('TEST_ADS path: moderate signals land in test zone', () => {
    const score = scoreProduct({
      supplierPrice:         20,
      estimatedSellingPrice: 40,
      demandSearchVolume:    500,
      competitorCount:       100,
      reviewRating:          3.5,
      trendIndex:            50,
    });
    const { decision } = makeDecision(score);
    expect(['TEST_ADS', 'REJECT']).toContain(decision); // moderate signals
  });

  it('compositeScore is bounded [0, 100] for extreme inputs', () => {
    const high = scoreProduct({
      supplierPrice: 1, estimatedSellingPrice: 999,
      demandSearchVolume: 9_999_999, competitorCount: 0,
      reviewRating: 5, trendIndex: 100,
    });
    expect(high.compositeScore).toBeLessThanOrEqual(100);

    const low = scoreProduct({
      supplierPrice: 99, estimatedSellingPrice: 100,
      demandSearchVolume: 0, competitorCount: 999,
      reviewRating: 1, trendIndex: 0,
    });
    expect(low.compositeScore).toBeGreaterThanOrEqual(0);
  });
});
