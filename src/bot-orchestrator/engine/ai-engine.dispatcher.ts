/**
 * AiEngineDispatcher — V70 Production Certified
 *
 * Decouples the bot execution worker from concrete AI engine implementations.
 * Workers call dispatcher.dispatch() — the dispatcher routes to the correct
 * versioned engine service based on the engineVersion field.
 *
 * V70: Updated to use AiProviderDispatcher directly (AiOrchestratorService
 * was a shim alias — this file now uses the canonical name).
 *
 * Adding a new engine version:
 *   1. Register its NestJS service in BotDispatchModule
 *   2. Add a case in the dispatch() switch statement
 *   3. No changes needed to worker or orchestrator code
 *
 * This class is the ONLY place that imports concrete engine services.
 * All other components in bot-orchestrator depend only on this interface.
 */

import { Injectable, Logger } from '@nestjs/common';

// V70: use canonical service name — shim alias removed
import {
  AiProviderDispatcher,
  AiOperation,
  OrchestratorRequest,
} from '../../ai-orchestrator/ai-provider-dispatcher.service';
import { AiRouter, SubscriptionTier } from '../../ai-orchestrator/ai-router.service';

export interface DispatchRequest {
  engineVersion: string;
  botState:      Record<string, unknown>;
  executionType: 'cycle' | 'test' | 'scale';
  tenantId:      string;
}

export interface DispatchResult {
  content:   unknown;
  source:    string;
  engine:    string;
  operation: string;
  latencyMs?: number;
}

@Injectable()
export class AiEngineDispatcher {
  private readonly logger = new Logger(AiEngineDispatcher.name);

  constructor(
    private readonly aiDispatcher: AiProviderDispatcher,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const { engineVersion, botState, executionType, tenantId } = request;
    const startMs = Date.now();

    this.logger.debug(
      `[Dispatcher] engine=${engineVersion} type=${executionType} tenant=${tenantId}`,
    );

    const operation = this.resolveOperation(botState, executionType);
    const tier       = String(botState['tier'] ?? 'free') as SubscriptionTier;

    const req: OrchestratorRequest = {
      userId:    tenantId,
      operation: operation as AiOperation,
      context:   botState,
      userTier:  tier,
    };

    switch (engineVersion) {
      case 'v42':
      case 'v41':
      case 'v29':
      default: {
        const result = await this.aiDispatcher.resolve(req);
        return {
          content:   result.content,
          source:    result.source,
          engine:    engineVersion,
          operation,
          latencyMs: Date.now() - startMs,
        };
      }
    }
  }

  private resolveOperation(
    botState:      Record<string, unknown>,
    executionType: string,
  ): string {
    const opMap: Record<string, string> = {
      cycle: 'scoring',
      test:  'scoring',
      scale: 'campaign:generate',
    };
    return String(botState['operation'] ?? opMap[executionType] ?? 'scoring');
  }
}
