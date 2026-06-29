/**
 * profit-engine.service.ts — V60 DEPRECATED
 *
 * ⚠️  THIS SERVICE IS DEPRECATED AS OF V60 ⚠️
 *
 * Migration:
 *   ❌ import { ProfitEngineService } from '../autonomous/profit-engine.service';
 *   ✅ import { UnifiedFinanceEngine } from '../finance/unified-finance-engine.service';
 *
 * Retained for V59 backward compatibility only. Remove in V61.
 */

import { Injectable, Logger } from '@nestjs/common';

/** @deprecated Use UnifiedFinanceEngine */
@Injectable()
export class ProfitEngineService {
  private readonly logger = new Logger(ProfitEngineService.name);
  constructor() {
    this.logger.warn('ProfitEngineService is DEPRECATED (V60). Use UnifiedFinanceEngine.');
  }


  decide(input: ProfitInput): ProfitOutput {
    return {
      storeId:     input.storeId,
      decision:    'HOLD',
      multiplier:  1.0,
      rationale:   'Fallback — live engine not invoked',
      actions:     [],
      realRoas:    input.signals?.roas as number ?? 0,
      netProfit:   0,
      confidence:  0.5,
      dataQuality: 0.5,
    };
  }
}

// ── V60 compatibility exports ─────────────────────────────────────────────────
export { ProfitEngineService as ProfitEngine };
export interface ProfitInput  { storeId: string; tenantId: string; cycleId: string; signals: Record<string, unknown>; campaignId?: string; adsetId?: string; spend?: number; revenue?: number; roas?: number; niche?: string; category?: string; productId?: string; supplierId?: string }
export interface ProfitOutput { storeId: string; decision: string; multiplier: number; rationale: string; actions?: ProfitAction[]; realRoas?: number; netProfit?: number; confidence?: number; dataQuality?: number }
export interface ProfitAction { type: string; target: string; params: Record<string, unknown>; payload?: Record<string, unknown> }
