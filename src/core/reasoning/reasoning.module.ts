/**
 * ReasoningModule — V54
 *
 * Provides:
 *   - ReasoningEngine          (@Global)
 *   - ScenarioSimulatorService
 *   - RiskEngine
 *
 * Imports FinanceModule for FinancialAiService (V53).
 * @Global so ReasoningEngine is injectable in V26, V29, V50 without re-import.
 */

import { Global, Module } from '@nestjs/common';
import { FinanceModule }             from '../finance/finance.module';
import { ReasoningEngine }           from './reasoning.engine';
import { ScenarioSimulatorService }  from './scenario-simulator.service';
import { RiskEngine }                from './risk.engine';

@Global()
@Module({
  imports:   [FinanceModule],
  providers: [RiskEngine, ScenarioSimulatorService, ReasoningEngine],
  exports:   [ReasoningEngine, ScenarioSimulatorService, RiskEngine],
})
export class ReasoningModule {}
