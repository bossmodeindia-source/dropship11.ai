/**
 * AiBotModule (V2 — Updated)
 *
 * NvidiaService now reads from ConfigVaultService (not ConfigService / process.env).
 * AiModeService now delegates to AiOrchestratorService (no direct API calls).
 * AiBotService now delegates to AiOrchestratorService (not AiModeService inline).
 *
 * ForwardRef is used for AiOrchestratorModule to resolve the circular dependency:
 *   AiBotModule → (exports BotModeService, NvidiaService used by) → AiOrchestratorModule
 *   AiBotService (in AiBotModule) → uses → AiOrchestratorService (in AiOrchestratorModule)
 *
 * NvidiaService and BotModeService are exported so AiOrchestratorModule can
 * consume them directly through AiProviderRegistry.
 */

import { Module, Global, forwardRef } from '@nestjs/common';
import { AiBotService     } from './ai-bot.service';
import { ToggleService    } from './toggle.service';
import { AiModeService    } from './modes/ai-mode.service';
import { BotModeService   } from './modes/bot-mode.service';
import { NvidiaService    } from './nvidia.service';
import { NemoGuardService } from './safety/nemoguard.service';
import { ConfigVaultModule } from '../config-vault/config-vault.module';
import { DatabaseModule    } from '../common/database/database.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';

@Global()
@Module({
  imports: [
    DatabaseModule,
    ConfigVaultModule,
    forwardRef(() => AiOrchestratorModule),
  ],
  providers: [
    NvidiaService,
    NemoGuardService,
    BotModeService,
    ToggleService,
    AiModeService,
    AiBotService,
  ],
  exports: [
    NvidiaService,
    NemoGuardService,
    BotModeService,
    AiBotService,
    ToggleService,
    AiModeService,
  ],
})
export class AiBotModule {}
