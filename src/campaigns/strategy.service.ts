/**
 * StrategyService (V2 — Refactored)
 *
 * BEFORE: Called NvidiaService.call253B() directly with its own spend gate.
 * AFTER:  Delegates to AiOrchestratorService. Spend gate + 24h cooldown
 *         are enforced in AiRouter — single source of truth, no duplication.
 *
 * Public interface (StrategyContext / StrategyResult) is preserved.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  AiOrchestratorService,
  OrchestratorRequest,
} from '../ai-orchestrator/ai-orchestrator.service';

export type StrategyDecision = 'SCALE' | 'PAUSE' | 'KILL' | 'HOLD';

export interface StrategyContext {
  campaignId:     string;
  userId:         string;
  productTitle:   string;
  category:       string;
  totalSpendUsd:  number;
  roas:           number;
  ctr:            number;
  conversions:    number;
  dailyBudgetUsd: number;
  daysRunning:    number;
  userTier?:      'free' | 'starter' | 'pro' | 'enterprise';
}

export interface StrategyResult {
  decision:                StrategyDecision;
  reasoning:               string;
  recommended_budget_delta: number;
  confidence:              number;
  model:                   string;
  latencyMs:               number;
  skipped?:                boolean;
  skipReason?:             string;
}

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  constructor(private readonly orchestrator: AiOrchestratorService) {}

  async evaluate(ctx: StrategyContext): Promise<StrategyResult> {
    this.logger.debug(
      `[Strategy] Evaluating campaign ${ctx.campaignId} ` +
      `(spend $${ctx.totalSpendUsd.toFixed(2)})`,
    );

    const req: OrchestratorRequest = {
      userId:        ctx.userId,
      operation:     'strategy',
      context:       this.buildContext(ctx),
      campaignSpend: ctx.totalSpendUsd,
      userTier:      ctx.userTier ?? 'free',
    };

    const result = await this.orchestrator.resolve(req);

    if (result.source === 'BOT') {
      return this.holdFallback(ctx, result.routingReason ?? 'bot_fallback');
    }

    return this.parseResult(result.content, result.source, result.latencyMs);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private buildContext(ctx: StrategyContext): Record<string, unknown> {
    return {
      campaignId:     ctx.campaignId,
      productTitle:   ctx.productTitle,
      category:       ctx.category,
      totalSpendUsd:  ctx.totalSpendUsd,
      roas:           ctx.roas,
      ctr:            ctx.ctr,
      conversions:    ctx.conversions,
      dailyBudgetUsd: ctx.dailyBudgetUsd,
      daysRunning:    ctx.daysRunning,
    };
  }

  private parseResult(
    content:   unknown,
    model:     string,
    latencyMs: number,
  ): StrategyResult {
    try {
      const raw = typeof content === 'string' ? JSON.parse(content) : content as Record<string, unknown>;
      const decision = this.validateDecision(raw['decision']);

      return {
        decision,
        reasoning:               (raw['reasoning']               as string)  ?? 'No reasoning provided.',
        recommended_budget_delta: (raw['recommended_budget_delta'] as number) ?? 0,
        confidence:              (raw['confidence']              as number)  ?? 50,
        model,
        latencyMs,
      };
    } catch {
      return this.holdFallback({ campaignId: 'unknown', userId: 'unknown' } as StrategyContext, 'parse_error');
    }
  }

  private validateDecision(raw: unknown): StrategyDecision {
    const valid: StrategyDecision[] = ['SCALE', 'PAUSE', 'KILL', 'HOLD'];
    const upper = String(raw ?? '').toUpperCase() as StrategyDecision;
    return valid.includes(upper) ? upper : 'HOLD';
  }

  private holdFallback(ctx: Partial<StrategyContext>, reason: string): StrategyResult {
    return {
      decision:                'HOLD',
      reasoning:               `Fallback HOLD — reason: ${reason}.`,
      recommended_budget_delta: 0,
      confidence:              0,
      model:                   'heuristic-fallback',
      latencyMs:               0,
      skipped:                 true,
      skipReason:              reason,
    };
  }
}
