/**
 * AI Provider Abstraction Layer
 *
 * Every AI backend (NVIDIA 49B, NVIDIA 253B, BotMode) implements AIProvider.
 * The AiProviderRegistry holds all registered providers and exposes
 * availability checks to the AiRouter.
 *
 * BotModeProvider and Nvidia providers inject their deps via forwardRef
 * to resolve the circular AiBotModule <-> AiOrchestratorModule dependency.
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { BotModeService } from '../ai-bot/modes/bot-mode.service';
import { NvidiaService, NVIDIA_49B_MODEL, NVIDIA_253B_MODEL } from '../ai-bot/nvidia.service';
import { ConfigVaultService } from '../config-vault/config-vault.service';

// ── Shared provider contract ──────────────────────────────────────────────────

export interface AIProviderRequest {
  messages:    Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  operation:   string;
  context:     Record<string, unknown>;
  temperature?: number;
  maxTokens?:   number;
}

export interface AIProviderResponse {
  content:   unknown;
  rawText:   string;
  usage:     { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  generate(request: AIProviderRequest): Promise<AIProviderResponse>;
}

// ── NVIDIA 49B Provider ───────────────────────────────────────────────────────

@Injectable()
export class Nvidia49BProvider implements AIProvider {
  readonly name = 'NVIDIA_49B';
  private readonly logger = new Logger(Nvidia49BProvider.name);

  constructor(
    @Inject(forwardRef(() => NvidiaService)) private readonly nvidia: NvidiaService,
    private readonly vault:  ConfigVaultService,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.vault.isAvailable('NVIDIA_49B_API_KEY');
  }

  async generate(req: AIProviderRequest): Promise<AIProviderResponse> {
    this.logger.debug(`[49B] Generating ${req.operation}`);
    const result = await this.nvidia.call49B(
      req.messages,
      req.temperature ?? 0.7,
      req.maxTokens   ?? 1500,
    );

    let parsed: unknown;
    try { parsed = JSON.parse(result.content); } catch { parsed = result.content; }

    return {
      content:   parsed,
      rawText:   result.content,
      usage:     result.usage,
      latencyMs: (result as { content: string; latencyMs?: number }).latencyMs ?? 0,
    };
  }
}

// ── NVIDIA 253B Provider ──────────────────────────────────────────────────────

@Injectable()
export class Nvidia253BProvider implements AIProvider {
  readonly name = 'NVIDIA_253B';
  private readonly logger = new Logger(Nvidia253BProvider.name);

  constructor(
    @Inject(forwardRef(() => NvidiaService)) private readonly nvidia: NvidiaService,
    private readonly vault:  ConfigVaultService,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.vault.isAvailable('NVIDIA_253B_API_KEY');
  }

  async generate(req: AIProviderRequest): Promise<AIProviderResponse> {
    this.logger.debug(`[253B] Generating strategy`);
    const result = await this.nvidia.call253B(
      req.messages,
      req.temperature ?? 0.3,
      req.maxTokens   ?? 2000,
    );

    let parsed: unknown;
    try { parsed = JSON.parse(result.content); } catch { parsed = result.content; }

    return {
      content:   parsed,
      rawText:   result.content,
      usage:     result.usage,
      latencyMs: (result as { content: string; latencyMs?: number }).latencyMs ?? 0,
    };
  }
}

// ── BotMode Provider (zero-cost deterministic fallback) ───────────────────────

@Injectable()
export class BotModeProvider implements AIProvider {
  readonly name = 'BOT';

  constructor(
    @Inject(forwardRef(() => BotModeService)) private readonly botMode: BotModeService,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true; // Always available — no external dependency
  }

  async generate(req: AIProviderRequest): Promise<AIProviderResponse> {
    const result = this.botMode.execute({
      operation: req.operation as 'listing' | 'campaign' | 'scoring' | 'media',
      context:   req.context,
    });

    let parsed: unknown;
    try { parsed = JSON.parse(result.content); } catch { parsed = result.content; }

    return {
      content:   parsed,
      rawText:   result.content,
      usage:     { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: (result as { content: string; latencyMs?: number }).latencyMs ?? 0,
    };
  }
}

// ── AiProviderRegistry ────────────────────────────────────────────────────────

@Injectable()
export class AiProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  constructor(
    private readonly nvidia49b:  Nvidia49BProvider,
    private readonly nvidia253b: Nvidia253BProvider,
    private readonly bot:        BotModeProvider,
  ) {
    this.register(nvidia49b);
    this.register(nvidia253b);
    this.register(bot);
  }

  register(provider: AIProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  async getAvailable(): Promise<AIProvider[]> {
    const checks = await Promise.all(
      [...this.providers.values()].map(async p => ({
        provider:  p,
        available: await p.isAvailable(),
      })),
    );
    return checks.filter(c => c.available).map(c => c.provider);
  }

  // Convenience typed accessors
  get49B():  Nvidia49BProvider  { return this.nvidia49b;  }
  get253B(): Nvidia253BProvider { return this.nvidia253b; }
  getBot():  BotModeProvider    { return this.bot;        }
}
