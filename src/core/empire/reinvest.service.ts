/**
 * ReinvestService — Profit Allocation Engine
 *
 * Splits profit into:
 *   - winners scaling  (aggressive: 60%, conservative: 40%)
 *   - new stores       (aggressive: 25%, conservative: 10%)
 *   - reserve          (aggressive: 15%, conservative: 50%)
 */

import { Injectable, Logger } from '@nestjs/common';
import { StrategyMode } from './longterm-strategy.service';

export interface ProfitAllocation {
  total:          number;
  winnersScaling: number;
  newStores:      number;
  reserve:        number;
  reinvested:     number; // winnersScaling + newStores
  reserved:       number; // reserve
}

const ALLOCATION_RATIOS: Record<StrategyMode, {
  winnersScaling: number;
  newStores:      number;
  reserve:        number;
}> = {
  aggressive: {
    winnersScaling: 0.60,
    newStores:      0.25,
    reserve:        0.15,
  },
  conservative: {
    winnersScaling: 0.40,
    newStores:      0.10,
    reserve:        0.50,
  },
};

@Injectable()
export class ReinvestService {
  private readonly logger = new Logger(ReinvestService.name);

  async allocate(profit: number, mode: StrategyMode): Promise<ProfitAllocation> {
    if (profit <= 0) {
      this.logger.warn(`[ReinvestService] No profit to allocate (profit=${profit})`);
      return {
        total: profit, winnersScaling: 0, newStores: 0,
        reserve: 0, reinvested: 0, reserved: 0,
      };
    }

    const ratios = ALLOCATION_RATIOS[mode];

    const winnersScaling = profit * ratios.winnersScaling;
    const newStores      = profit * ratios.newStores;
    const reserve        = profit * ratios.reserve;

    this.logger.log(
      `[ReinvestService] mode=${mode} profit=${profit.toFixed(2)} ` +
      `winners=${winnersScaling.toFixed(2)} stores=${newStores.toFixed(2)} ` +
      `reserve=${reserve.toFixed(2)}`,
    );

    return {
      total:          profit,
      winnersScaling,
      newStores,
      reserve,
      reinvested:     winnersScaling + newStores,
      reserved:       reserve,
    };
  }
}
