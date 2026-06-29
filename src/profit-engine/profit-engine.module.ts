/**
 * ProfitEngineModule — V31 Profit Maximization Layer
 *
 * Registers all 6 profit-engine services as NestJS providers.
 * Exports ALL services for injection into V30KernelService and V28 modules.
 *
 * Import order in AppModule:
 *   V15Module → ... →
 → ProfitEngineModule
 *   (ProfitEngineModule must follow
: it injects GlobalCapitalOptimizer
 *   and StrategyEvolverService which depend on DatabaseModule and RedisModule)
 *
 * Tokens:
 *   PROFIT_ENGINE_TOKENS.PG_POOL — pg.Pool instance (from DatabaseModule)
 *   PROFIT_ENGINE_TOKENS.REDIS   — ioredis instance  (from RedisModule)
 */

import { Module, Global }   from '@nestjs/common';
import { Pool }             from 'pg';
import Redis                from 'ioredis';
import { DatabaseModule }   from '../common/database/database.module';
import { RedisModule }      from '../common/redis/redis.module';

import { ProfitMaximizerEngine }     from './profit-maximizer.engine';
import { GlobalCapitalOptimizer }    from './global-capital-optimizer.service';
import { WinnerAccelerationEngine }  from './winner-acceleration.engine';
import { LossCutterEngine }          from './loss-cutter.engine';
import { AdvancedBanditEngine }      from './advanced-bandit.engine';
import { StrategyEvolverService }    from './strategy-evolver.service';
import { GlobalProfitTargetService } from './global-profit-target.service';

// ── DI Tokens ─────────────────────────────────────────────────────────────────
export const PROFIT_ENGINE_TOKENS = {
  PG_POOL: 'PROFIT_ENGINE_PG_POOL',
  REDIS:   'PROFIT_ENGINE_REDIS',
} as const;

@Global()
@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [
    // ── Database + Redis token providers ────────────────────────────────────
    {
      provide:    PROFIT_ENGINE_TOKENS.PG_POOL,
      useFactory: (pool: Pool) => pool,
      inject:     ['PG_POOL'],      // token exported by DatabaseModule (POOL_TOKEN)
    },
    {
      provide:    PROFIT_ENGINE_TOKENS.REDIS,
      useFactory: (redis: Redis) => redis,
      inject:     ['REDIS_CLIENT'],     // token exported by RedisModule
    },

    // ── Profit engine services ───────────────────────────────────────────────
    ProfitMaximizerEngine,
    GlobalCapitalOptimizer,
    WinnerAccelerationEngine,
    LossCutterEngine,
    AdvancedBanditEngine,
    StrategyEvolverService,
    GlobalProfitTargetService,
  ],
  exports: [
    ProfitMaximizerEngine,
    GlobalCapitalOptimizer,
    WinnerAccelerationEngine,
    LossCutterEngine,
    AdvancedBanditEngine,
    StrategyEvolverService,
    GlobalProfitTargetService,
  ],
})
export class ProfitEngineModule {}
