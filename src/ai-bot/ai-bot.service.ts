/**
 * AiBotService (V2 — Updated)
 *
 * Thin delegation layer that preserves the existing public API
 * (dispatch signature unchanged) while routing every call through
 * AiOrchestratorService instead of calling AiModeService + NvidiaService directly.
 *
 * ForwardRef injection is used to break the circular dependency with
 * AiOrchestratorModule. AiBotService uses Inject(forwardRef) for the orchestrator.
 */

import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AiOrchestratorService, OrchestratorRequest } from '../ai-orchestrator/ai-orchestrator.service';
import { ToggleService } from './toggle.service';

export interface DispatchRequest {
  userId:        string;
  operation:     'listing' | 'campaign' | 'scoring' | 'media';
  context:       Record<string, unknown>;
  systemPrompt?: string;
  productScore?: number;
  userTier?:     'free' | 'starter' | 'pro' | 'enterprise';
}

export interface DispatchResponse {
  content:   unknown;
  mode:      'AI' | 'BOT' | 'CACHE';
  operation: string;
  latencyMs: number;
  source?:   string;
  usage?:    { promptTokens: number; completionTokens: number; totalTokens: number };
}

@Injectable()
export class AiBotService {
  private readonly logger = new Logger(AiBotService.name);

  constructor(
    @Inject(DB_TOKEN)                              private readonly db:           NodePgDatabase<typeof schema>,
    private readonly toggle:                       ToggleService,
    @Inject(forwardRef(() => AiOrchestratorService))
    private readonly orchestrator: AiOrchestratorService,
  ) {}

  /**
   * Main dispatch — unchanged public signature.
   * All AI routing logic now lives in AiOrchestratorService.
   */
  async dispatch(req: DispatchRequest): Promise<DispatchResponse> {
    this.logger.debug(`[AiBot] Dispatching ${req.operation} for user ${req.userId}`);

    const userTier = req.userTier ?? await this.resolveUserTier(req.userId);

    const orcReq: OrchestratorRequest = {
      userId:       req.userId,
      operation:    req.operation,
      context:      req.context,
      systemPrompt: req.systemPrompt,
      productScore: req.productScore ?? 0,
      userTier,
    };

    const result = await this.orchestrator.resolve(orcReq);

    void this.orchestrator.logUsage(
      req.userId,
      req.operation,
      result.source,
      result.usage,
      result.latencyMs,
    );

    const modeMap: Record<string, 'AI' | 'BOT' | 'CACHE'> = {
      BOT:         'BOT',
      NVIDIA_49B:  'AI',
      NVIDIA_253B: 'AI',
      CACHE_L1:    'CACHE',
      CACHE_L2:    'CACHE',
    };

    return {
      content:   result.content,
      mode:      modeMap[result.source] ?? 'BOT',
      operation: req.operation,
      latencyMs: result.latencyMs,
      source:    result.source,
      usage:     result.usage,
    };
  }

  private async resolveUserTier(
    userId: string,
  ): Promise<'free' | 'starter' | 'pro' | 'enterprise'> {
    try {
      const sub = await this.db.query.subscriptions.findFirst({
        where: (s, { eq }) => eq(s.userId, userId),
      });
      return (sub?.tier as 'free' | 'starter' | 'pro' | 'enterprise') ?? 'free';
    } catch {
      return 'free';
    }
  }
}
