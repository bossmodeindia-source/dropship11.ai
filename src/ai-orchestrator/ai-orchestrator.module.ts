import { Module, forwardRef }             from '@nestjs/common';
import { AiProviderDispatcher }          from './ai-provider-dispatcher.service';
import { AiRouter }                       from './ai-router.service';
import { SemanticCacheService }           from './semantic-cache.service';
import { MemoryService }                  from './memory.service';
import { CircuitBreakerService }          from './circuit-breaker.service';
import { CooldownService }                from './cooldown.service';
import { AiProviderResilienceService }    from './ai-provider-resilience.service';
import {
  AiProviderRegistry,
  BotModeProvider,
  Nvidia49BProvider,
  Nvidia253BProvider,
} from './ai-provider.registry';
import { DatabaseModule }   from '../common/database/database.module';
import { ConfigVaultModule } from '../config-vault/config-vault.module';
import { AiBotModule }      from '../ai-bot/ai-bot.module';
import { MetricsModule }    from '../metrics/metrics.module';

// Legacy alias — keeps all 24 downstream callers compiling without modification
export { AiProviderDispatcher as AiOrchestratorService } from './ai-provider-dispatcher.service';

@Module({
  imports: [
    DatabaseModule,
    ConfigVaultModule,
    forwardRef(() => AiBotModule),
    MetricsModule,
  ],
  providers: [
    // Core orchestration
    AiProviderDispatcher,
    AiRouter,
    SemanticCacheService,
    MemoryService,
    CircuitBreakerService,
    CooldownService,
    // V65: Resilience layer — fallback chains + degraded mode
    AiProviderResilienceService,

    // Provider abstraction layer
    Nvidia49BProvider,
    Nvidia253BProvider,
    BotModeProvider,
    AiProviderRegistry,
  ],
  exports: [
    AiProviderDispatcher,
    MemoryService,
    SemanticCacheService,
    CircuitBreakerService,
    CooldownService,
    AiProviderResilienceService,  // exported so modules can call executeWithFallback()
  ],
})
export class AiOrchestratorModule {}

// Secondary module alias used in BotDispatchModule + CampaignsModule
export { AiOrchestratorModule as AiProviderDispatchModule };
