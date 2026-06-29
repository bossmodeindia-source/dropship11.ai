/**
 * AiModeService (V2 — Refactored)
 *
 * BEFORE: Called OpenAI directly (gpt-4o-mini) with hardcoded process.env reads.
 * AFTER:  Zero direct API calls. Delegates 100% to AiOrchestratorService.
 *
 * Uses forwardRef injection to avoid circular dependency with AiOrchestratorModule.
 * The public AiRequest / AiResponse interface is preserved for backward compatibility.
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { AiOrchestratorService } from '../../ai-orchestrator/ai-orchestrator.service';

export interface AiRequest {
  operation:     'listing' | 'campaign' | 'scoring' | 'media';
  context:       Record<string, unknown>;
  systemPrompt?: string;
  userId?:       string;
  productScore?: number;
  userTier?:     'free' | 'starter' | 'pro' | 'enterprise';
}

export interface AiResponse {
  content:   string;
  model:     string;
  usage:     { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

@Injectable()
export class AiModeService {
  private readonly logger = new Logger(AiModeService.name);

  constructor(
    @Inject(forwardRef(() => AiOrchestratorService))
    private readonly orchestrator: AiOrchestratorService,
  ) {}

  async execute(req: AiRequest): Promise<AiResponse> {
    this.logger.debug(`[AiMode] Delegating ${req.operation} → Orchestrator`);

    const result = await this.orchestrator.resolve({
      userId:       req.userId       ?? 'system',
      operation:    req.operation,
      context:      req.context,
      systemPrompt: req.systemPrompt,
      productScore: req.productScore ?? 0,
      userTier:     req.userTier     ?? 'free',
    });

    return {
      content:   typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content),
      model:     result.source,
      usage:     result.usage ?? ZERO_USAGE,
      latencyMs: result.latencyMs,
    };
  }
}
