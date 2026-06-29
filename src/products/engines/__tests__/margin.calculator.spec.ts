import { MarginCalculator } from '../margin.calculator';

describe('MarginCalculator', () => {
  let calc: MarginCalculator;

  beforeEach(() => {
    calc = new MarginCalculator();
  });

  describe('calculate()', () => {
    it('returns zero scores when sellingPrice is 0', () => {
      const result = calc.calculate({ supplierPrice: 10, sellingPrice: 0 });
      expect(result.grossMargin).toBe(0);
      expect(result.marginScore).toBe(0);
    });

    it('computes correct gross margin', () => {
      // sell=100, supplier=40, shipping=5, platformFee=3% → fee=3 → gross=52
      const result = calc.calculate({
        supplierPrice: 40,
        sellingPrice: 100,
        shippingCost: 5,
        platformFeePercent: 0.03,
      });
      expect(result.grossMargin).toBe(52);
    });

    it('computes net margin after ad spend', () => {
      const result = calc.calculate({
        supplierPrice: 40,
        sellingPrice: 100,
        shippingCost: 5,
        adSpend: 15,
        platformFeePercent: 0.03,
      });
      expect(result.netMargin).toBe(37);
    });

    it('computes ROAS breakeven', () => {
      const result = calc.calculate({
        supplierPrice: 20,
        sellingPrice: 80,
        adSpend: 20,
      });
      expect(result.roasBreakeven).toBe(4);
    });

    it('assigns high marginScore for 50%+ gross margin', () => {
      // 60% gross margin → score should be near 90
      const result = calc.calculate({
        supplierPrice: 10,
        sellingPrice: 25,
      });
      const grossPercent = ((25 - 10) / 25) * 100; // 60%
      expect(grossPercent).toBeCloseTo(60);
      expect(result.marginScore).toBeGreaterThanOrEqual(85);
    });

    it('assigns low marginScore for sub-10% gross margin', () => {
      const result = calc.calculate({
        supplierPrice: 95,
        sellingPrice: 100,
      });
      expect(result.marginScore).toBeLessThan(15);
    });

    it('caps marginScore at 100', () => {
      const result = calc.calculate({
        supplierPrice: 1,
        sellingPrice: 1000,
      });
      expect(result.marginScore).toBeLessThanOrEqual(100);
    });
  });
});
