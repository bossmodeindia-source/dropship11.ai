/**
 * TaxService — V53 Tax Estimator
 *
 * Estimates GST / income tax liability and profit after tax.
 * Rates configurable via env vars — defaults to Indian GST structure.
 *
 * NOT connected to any real tax filing API — estimation only.
 */

import { Injectable, Logger } from '@nestjs/common';

export interface TaxEstimate {
  grossProfit:     number;
  gstLiability:    number;   // 18% GST on revenue
  incomeTaxLiab:   number;   // 30% on net profit (simplified)
  totalTaxLiab:    number;
  profitAfterTax:  number;
  effectiveTaxRate: number;
}

const GST_RATE          = parseFloat(process.env.TAX_GST_RATE         ?? '0.18');
const INCOME_TAX_RATE   = parseFloat(process.env.TAX_INCOME_RATE      ?? '0.30');
const GST_THRESHOLD_INR = parseFloat(process.env.TAX_GST_THRESHOLD    ?? '2000000'); // ₹20L

@Injectable()
export class TaxService {
  private readonly log = new Logger(TaxService.name);

  estimate(params: {
    revenue:    number;
    grossProfit: number;
  }): TaxEstimate {
    const { revenue, grossProfit } = params;

    // GST: applicable if turnover > threshold
    const gstLiability = revenue >= GST_THRESHOLD_INR
      ? parseFloat((revenue * GST_RATE).toFixed(2))
      : 0;

    // Income tax: on gross profit after GST
    const taxableProfit  = Math.max(0, grossProfit - gstLiability);
    const incomeTaxLiab  = parseFloat((taxableProfit * INCOME_TAX_RATE).toFixed(2));
    const totalTaxLiab   = parseFloat((gstLiability + incomeTaxLiab).toFixed(2));
    const profitAfterTax = parseFloat((grossProfit - totalTaxLiab).toFixed(2));
    const effectiveTaxRate = grossProfit > 0
      ? parseFloat((totalTaxLiab / grossProfit).toFixed(4))
      : 0;

    return {
      grossProfit,
      gstLiability,
      incomeTaxLiab,
      totalTaxLiab,
      profitAfterTax,
      effectiveTaxRate,
    };
  }
}
