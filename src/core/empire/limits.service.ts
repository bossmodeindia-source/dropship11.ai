/**
 * EmpireLimitsService — Global Hard Limits
 *
 * Controls:
 *   - max exposure (total capital at risk)
 *   - max stores
 *   - max daily spend
 *   - capital guard (loss > threshold → halt)
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CapitalGuardResult {
  halted:  boolean;
  reason?: string;
}

@Injectable()
export class EmpireLimitsService {
  private readonly logger = new Logger(EmpireLimitsService.name);

  private readonly MAX_STORES      : number;
  private readonly MAX_EXPOSURE_INR: number;
  private readonly MAX_DAILY_SPEND : number;
  private readonly LOSS_THRESHOLD  : number; // % of capital

  constructor(private readonly config: ConfigService) {
    this.MAX_STORES       = config.get<number>('EMPIRE_MAX_STORES',        20);
    this.MAX_EXPOSURE_INR = config.get<number>('EMPIRE_MAX_EXPOSURE_INR',  500_000);
    this.MAX_DAILY_SPEND  = config.get<number>('EMPIRE_MAX_DAILY_SPEND',   100_000);
    this.LOSS_THRESHOLD   = config.get<number>('EMPIRE_LOSS_THRESHOLD_PCT', 15);
  }

  async canAddStore(currentStores: number): Promise<boolean> {
    if (currentStores >= this.MAX_STORES) {
      this.logger.warn(`[EmpireLimits] Max stores reached: ${currentStores}/${this.MAX_STORES}`);
      return false;
    }
    return true;
  }

  async checkExposure(totalAtRisk: number): Promise<boolean> {
    if (totalAtRisk > this.MAX_EXPOSURE_INR) {
      this.logger.warn(`[EmpireLimits] Exposure breach: ${totalAtRisk} > ${this.MAX_EXPOSURE_INR}`);
      return false;
    }
    return true;
  }

  async checkCapitalGuard(currentCapital: number): Promise<CapitalGuardResult> {
    // Track starting capital to compute loss %
    // Simple check: if capital is near 0, halt
    if (currentCapital <= 0) {
      return { halted: true, reason: 'CAPITAL_DEPLETED' };
    }

    // Loss > threshold of initial seed capital (read from config or DB)
    const seedCapital = this.config.get<number>('EMPIRE_SEED_CAPITAL_INR', 100_000);
    const lossAmt  = seedCapital - currentCapital;
    const lossPct  = (lossAmt / seedCapital) * 100;

    if (lossPct > this.LOSS_THRESHOLD) {
      const reason = `Loss ${lossPct.toFixed(1)}% exceeds threshold ${this.LOSS_THRESHOLD}%`;
      this.logger.error(`[EmpireLimits] CAPITAL GUARD: ${reason}`);
      return { halted: true, reason };
    }

    return { halted: false };
  }

  getLimits(): Record<string, number> {
    return {
      maxStores:      this.MAX_STORES,
      maxExposureINR: this.MAX_EXPOSURE_INR,
      maxDailySpend:  this.MAX_DAILY_SPEND,
      lossThresholdPct: this.LOSS_THRESHOLD,
    };
  }
}
