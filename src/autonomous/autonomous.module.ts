/**
 * AutonomousModule — V66 ENTERPRISE HARDENED
 *
 * V66 CRITICAL FIX #4: SINGLE ORCHESTRATOR ENFORCEMENT
 *
 *   ❌ REMOVED: AutonomousLoopService (creates parallel autonomous loops)
 *   ✅ KEPT:    UnifiedCommerceOrchestrator (single distributed-locked orchestrator)
 *   ✅ ADDED:   Redis distributed lock enforcement
 *
 * The AutonomousLoopService has been REMOVED from this module.
 * All autonomous execution MUST flow through UnifiedCommerceOrchestrator
 * which holds a single Redis distributed lock per tenant:
 *
 *   Redis Key: autonomous:cycle:lock:{tenantId}
 *
 * Multiple instances, multiple containers, multiple restarts — only ONE
 * autonomous cycle can be active at any time per tenant.
 *
 * FORBIDDEN: Starting any autonomous loop outside of UnifiedCommerceOrchestrator.
 */

import { Module }                   from '@nestjs/common';
import { DatabaseModule }           from '../common/database/database.module';
import { MetaAdsModule }            from '../meta-ads/meta-ads.module';
import { AiOrchestratorModule }     from '../ai-orchestrator/ai-orchestrator.module';
import { RedisModule }              from '../common/redis/redis.module';
import { SafetyModule }             from '../safety/safety.module';

import { ShopifyRevenueService }        from '../shopify/shopify-revenue.service';
import { ProfitEngine }                 from './profit-engine.service';
import { WinnerDnaService }             from './winner-dna.service';
import { SelfHealingCreativeEngine }    from '../ad-creatives/self-healing-creative.engine';
import { OptimizationScheduler }        from '../workers/optimization.scheduler';
import { NicheDiscoveryService }        from './niche-discovery.service';
import { ProductDiscoveryService }      from './product-discovery.service';
import { ProductPredictionEngine }      from './product-prediction.engine';
import { CreativeEvolutionEngine }      from './creative-evolution.engine';
import { MultiArmedBanditEngine }       from './multi-armed-bandit.engine';
import { CategoryIntelligenceService }  from './category-intelligence.service';
import { AutonomousController }         from './autonomous.controller';
import { StrategyService }              from '../campaigns/strategy.service';
import { CooldownService }              from '../ai-orchestrator/cooldown.service';
import { MetaApiClient }               from '../meta-ads/meta-api.client';
import { MultiWinnerTrackerService }    from './multi-winner-tracker.service';
import { NicheDominationService }       from './niche-domination.service';
import { ProfitCompoundingEngine }      from './profit-compounding.engine';
import { ProfitMultipliersService }     from '../profit-multipliers/profit-multipliers.service';
import { AiCostOptimizer }              from '../ai-orchestrator/ai-cost-optimizer.service';

// NOTE: AutonomousLoopService intentionally NOT imported.
// All autonomous execution is coordinated by UnifiedCommerceOrchestrator (@Global).

@Module({
  imports: [
    DatabaseModule,
    MetaAdsModule,
    AiOrchestratorModule,
    RedisModule,   // Required for distributed lock access
    SafetyModule,
  ],
  providers: [
    ShopifyRevenueService,
    ProfitEngine,
    WinnerDnaService,
    SelfHealingCreativeEngine,
    OptimizationScheduler,
    // AutonomousLoopService — REMOVED in V66 (creates parallel loops)
    StrategyService,
    CooldownService,
    MetaApiClient,
    NicheDiscoveryService,
    ProductDiscoveryService,
    ProductPredictionEngine,
    CreativeEvolutionEngine,
    MultiArmedBanditEngine,
    CategoryIntelligenceService,
    MultiWinnerTrackerService,
    NicheDominationService,
    ProfitCompoundingEngine,
    ProfitMultipliersService,
    AiCostOptimizer,
  ],
  controllers: [AutonomousController],
  exports: [
    ProfitEngine,
    ShopifyRevenueService,
    WinnerDnaService,
    SelfHealingCreativeEngine,
    OptimizationScheduler,
    // AutonomousLoopService — REMOVED; not exported
    MultiWinnerTrackerService,
    NicheDominationService,
    ProfitCompoundingEngine,
    ProfitMultipliersService,
    AiCostOptimizer,
  ],
})
export class AutonomousModule {}
