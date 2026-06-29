import { Injectable } from '@nestjs/common';

export interface MarginInput {
  supplierPrice: number;
  sellingPrice: number;
  shippingCost?: number;
  adSpend?: number;
  platformFeePercent?: number;
}

export interface MarginResult {
  grossMargin: number;
  netMargin: number;
  roasBreakeven: number;
  marginScore: number; // 0-100
}

@Injectable()
export class MarginCalculator {
  calculate(input: MarginInput): MarginResult {
    const {
      supplierPrice,
      sellingPrice,
      shippingCost = 0,
      adSpend = 0,
      platformFeePercent = 0.03,
    } = input;

    if (sellingPrice <= 0) {
      return { grossMargin: 0, netMargin: 0, roasBreakeven: 0, marginScore: 0 };
    }

    const platformFee = sellingPrice * platformFeePercent;
    const grossMargin = sellingPrice - supplierPrice - shippingCost - platformFee;
    const netMargin = grossMargin - adSpend;

    const grossMarginPercent = (grossMargin / sellingPrice) * 100;

    // ROAS breakeven: selling_price / ad_spend (how much revenue per ad dollar to break even)
    const roasBreakeven = adSpend > 0 ? sellingPrice / adSpend : 0;

    // Score: 0-100 based on gross margin %
    // < 10% → 0-20, 10-20% → 20-40, 20-40% → 40-70, 40-60% → 70-90, >60% → 90-100
    let marginScore: number;
    if (grossMarginPercent < 0) {
      marginScore = 0;
    } else if (grossMarginPercent < 10) {
      marginScore = grossMarginPercent * 2;
    } else if (grossMarginPercent < 20) {
      marginScore = 20 + (grossMarginPercent - 10) * 2;
    } else if (grossMarginPercent < 40) {
      marginScore = 40 + (grossMarginPercent - 20) * 1.5;
    } else if (grossMarginPercent < 60) {
      marginScore = 70 + (grossMarginPercent - 40) * 1;
    } else {
      marginScore = Math.min(100, 90 + (grossMarginPercent - 60) * 0.5);
    }

    return {
      grossMargin: Math.round(grossMargin * 100) / 100,
      netMargin: Math.round(netMargin * 100) / 100,
      roasBreakeven: Math.round(roasBreakeven * 100) / 100,
      marginScore: Math.round(marginScore * 100) / 100,
    };
  }
}
