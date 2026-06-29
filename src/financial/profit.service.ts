/**
 * profit.service.ts — V60 DEPRECATED
 *
 * ⚠️  THIS SERVICE IS DEPRECATED AS OF V60 ⚠️
 *
 * DO NOT inject ProfitService in new code.
 * DO NOT add new methods here.
 *
 * Migration:
 *   ❌ import { ProfitService } from '../financial/profit.service';
 *   ✅ import { UnifiedFinanceEngine } from '../finance/unified-finance-engine.service';
 *
 * This file is retained ONLY for backward compatibility with existing V59
 * services that still reference it. It will be removed in V61.
 *
 * All new financial calculations MUST use UnifiedFinanceEngine.
 */

import { Injectable, Logger } from '@nestjs/common';

/** @deprecated Use UnifiedFinanceEngine from src/finance/unified-finance-engine.service.ts */
@Injectable()
export class ProfitService {
  private readonly logger = new Logger(ProfitService.name);

  constructor() {
    this.logger.warn(
      'ProfitService is DEPRECATED (V60). Migrate to UnifiedFinanceEngine. ' +
      'See INTEGRATION_NOTES.md for migration guide.',
    );
  }

  /** @deprecated Use UnifiedFinanceEngine.getUserFacingSnapshot() */
  calculateRevenue(orders: Array<{ quantity: number; unitPrice: number }>): number {
    if (!orders.length) return 0;
    return Math.round(orders.reduce((sum, o) => sum + o.quantity * o.unitPrice, 0) * 100) / 100;
  }

  /** @deprecated Use UnifiedFinanceEngine.computeProfitSnapshot() */
  calculateProfit(revenue: number, costs: number): number {
    return Math.round((revenue - costs) * 100) / 100;
  }

  /** @deprecated Use UnifiedFinanceEngine.shouldScaleUp() */
  calculateRoas(revenue: number, adSpend: number): number {
    if (adSpend <= 0) return 0;
    return Math.round((revenue / adSpend) * 100) / 100;
  }
}
