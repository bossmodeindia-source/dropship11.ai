import { scoreProduct, RawProductSignals } from '../scoring.engine';

describe('scoreProduct()', () => {
  const base: RawProductSignals = {
    supplierPrice:         20,
    estimatedSellingPrice: 60,
    demandSearchVolume:    5_000,
    competitorCount:       50,
    reviewRating:          4.2,
    trendIndex:            65,
  };

  it('returns all required score fields', () => {
    const r = scoreProduct(base);
    expect(r).toHaveProperty('demandScore');
    expect(r).toHaveProperty('competitionScore');
    expect(r).toHaveProperty('marginScore');
    expect(r).toHaveProperty('trendScore');
    expect(r).toHaveProperty('compositeScore');
  });

  it('all scores are within [0, 100]', () => {
    const r = scoreProduct(base);
    for (const v of [r.demandScore, r.competitionScore, r.marginScore, r.trendScore, r.compositeScore]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('higher selling price relative to supplier yields higher marginScore', () => {
    const low  = scoreProduct({ ...base, estimatedSellingPrice: 22 }); // ~9% margin
    const high = scoreProduct({ ...base, estimatedSellingPrice: 80 }); // 75% margin
    expect(high.marginScore).toBeGreaterThan(low.marginScore);
  });

  it('higher search volume yields higher demandScore', () => {
    const low  = scoreProduct({ ...base, demandSearchVolume: 10 });
    const high = scoreProduct({ ...base, demandSearchVolume: 100_000 });
    expect(high.demandScore).toBeGreaterThan(low.demandScore);
  });

  it('fewer competitors yields higher competitionScore', () => {
    const few  = scoreProduct({ ...base, competitorCount: 5 });
    const many = scoreProduct({ ...base, competitorCount: 180 });
    expect(few.competitionScore).toBeGreaterThan(many.competitionScore);
  });

  it('passes trendIndex through unchanged when within range', () => {
    const r = scoreProduct({ ...base, trendIndex: 80 });
    expect(r.trendScore).toBe(80);
  });

  it('clamps trendIndex to [0, 100]', () => {
    const over  = scoreProduct({ ...base, trendIndex: 150 });
    const under = scoreProduct({ ...base, trendIndex: -20 });
    expect(over.trendScore).toBe(100);
    expect(under.trendScore).toBe(0);
  });

  it('compositeScore is weighted sum of components (0.3+0.25+0.3+0.15)', () => {
    const r = scoreProduct(base);
    const expected =
      r.demandScore * 0.3 +
      r.competitionScore * 0.25 +
      r.marginScore * 0.3 +
      r.trendScore * 0.15;
    expect(r.compositeScore).toBeCloseTo(expected, 0);
  });

  it('zero selling price results in zero marginScore', () => {
    const r = scoreProduct({ ...base, estimatedSellingPrice: 0 });
    expect(r.marginScore).toBe(0);
  });
});
