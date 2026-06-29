/**
 * ai-orchestrator.service.ts — COMPATIBILITY SHIM
 *
 * V70: AiOrchestratorService was consolidated into AiProviderDispatcher.
 * This shim re-exports AiProviderDispatcher under the legacy name so that
 * all existing callers compile without modification.
 *
 * Architecture rule: no new code should import AiOrchestratorService.
 * Use AiProviderDispatcher directly for new features.
 *
 * Migration path:
 *   Old: import { AiOrchestratorService } from '../ai-orchestrator/ai-orchestrator.service'
 *   New: import { AiProviderDispatcher }  from '../ai-orchestrator/ai-provider-dispatcher.service'
 */

export {
  AiProviderDispatcher          as AiOrchestratorService,
  AiOperation,
  OrchestratorRequest,
  OrchestratorResponse,
} from './ai-provider-dispatcher.service';
