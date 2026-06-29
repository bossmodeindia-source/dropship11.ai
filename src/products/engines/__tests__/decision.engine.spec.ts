import { makeDecision } from '../decision.engine';
import { ScoringResult } from '../scoring.engine';

const makeScore = (overrides: Partial<ScoringResult> = {}): ScoringResult => ({
  demandScore:      60,
  competitionScore: 60,
  marginScore:      60,
  trendScore:       60,
  trendIndex:       60,
  compositeScore:   60,
  signalQuality:    'HIGH',
  signalWarnings:   [],
  ...overrides,
});

describe('makeDecision()', () => {
  it('returns RUN_ADS when compositeScore >= 70', () => {
    expect(makeDecision(makeScore({ compositeScore: 75 })).decision).toBe('RUN_ADS');
    expect(makeDecision(makeScore({ compositeScore: 70 })).decision).toBe('RUN_ADS');
    expect(makeDecision(makeScore({ compositeScore: 100 })).decision).toBe('RUN_ADS');
  });

  it('returns TEST_ADS when compositeScore is 45–69', () => {
    expect(makeDecision(makeScore({ compositeScore: 45 })).decision).toBe('TEST_ADS');
    expect(makeDecision(makeScore({ compositeScore: 55 })).decision).toBe('TEST_ADS');
    expect(makeDecision(makeScore({ compositeScore: 69 })).decision).toBe('TEST_ADS');
  });

  it('returns REJECT when compositeScore < 45', () => {
    expect(makeDecision(makeScore({ compositeScore: 44 })).decision).toBe('REJECT');
    expect(makeDecision(makeScore({ compositeScore: 10 })).decision).toBe('REJECT');
    expect(makeDecision(makeScore({ compositeScore: 0 })).decision).toBe('REJECT');
  });

  it('hard-rejects when marginScore < 20 regardless of composite', () => {
    const r = makeDecision(makeScore({ compositeScore: 90, marginScore: 15 }));
    expect(r.decision).toBe('REJECT');
    expect(r.reason).toContain('Margin score 15 < 20');
  });

  it('hard-rejects when demandScore < 15 regardless of composite', () => {
    const r = makeDecision(makeScore({ compositeScore: 90, demandScore: 10 }));
    expect(r.decision).toBe('REJECT');
    expect(r.reason).toContain('Demand score 10 < 15');
  });

  it('margin check takes priority over demand check', () => {
    const r = makeDecision(makeScore({ marginScore: 5, demandScore: 5, compositeScore: 90 }));
    expect(r.reason).toContain('Margin score 5 < 20');
  });

  it('always returns a non-empty reason string', () => {
    [0, 30, 50, 72, 95].forEach((compositeScore) => {
      const r = makeDecision(makeScore({ compositeScore }));
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    });
  });
});
