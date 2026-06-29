/**
 * finance.module.ts — V60 Unified Finance Module
 *
 * Canonical registration of UnifiedFinanceEngine.
 * @Global — no other module needs to import this; just inject UnifiedFinanceEngine.
 *
 * Replaces:
 *   - FinancialModule      (financial/financial.module.ts)  → DELETED
 *   - AutonomousModule's ProfitEngine                       → DELETED
 *   - V36Module's financial services (kept for V36 strategy but finance goes here)
 */

import { Global, Module } from '@nestjs/common';
import { UnifiedFinanceEngine } from './unified-finance-engine.service';

@Global()
@Module({
  providers: [UnifiedFinanceEngine],
  exports:   [UnifiedFinanceEngine],
})
export class FinanceModule {}
