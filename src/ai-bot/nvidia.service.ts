/**
 * NvidiaService (V2 — Updated)
 *
 * Reads API keys exclusively from ConfigVaultService — zero process.env access.
 * Mock mode is automatic when keys are absent (MOCK / PARTIAL system modes).
 *
 * This service is an INTERNAL implementation detail of the AI Orchestrator.
 * No external module should call it directly — all callers use AiOrchestratorService.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigVaultService } from '../config-vault/config-vault.service';

export const NVIDIA_49B_MODEL  = 'meta/llama-3.3-nemotron-super-49b-v1';
export const NVIDIA_253B_MODEL = 'meta/llama-3.1-nemotron-ultra-253b-v1';

export type NvidiaModel = typeof NVIDIA_49B_MODEL | typeof NVIDIA_253B_MODEL;

export interface NvidiaMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

export interface NvidiaCallOptions {
  model:        NvidiaModel;
  messages:     NvidiaMessage[];
  temperature?: number;
  maxTokens?:   number;
}

export interface NvidiaCallResult {
  content:  string;
  model:    NvidiaModel;
  usage: {
    promptTokens:     number;
    completionTokens: number;
    totalTokens:      number;
  };
  latencyMs: number;
}

const MOCK_RESPONSE: Record<NvidiaModel, string> = {
  [NVIDIA_49B_MODEL]:  JSON.stringify({
    title:       'Mock Product — Free Shipping',
    description: 'Quality guaranteed. Order today.',
    tags:        ['mock', 'dropship'],
    hook:        'Stop scrolling — this changes everything.',
    headline:    'Premium quality, unbeatable price',
    body:        'Join 10,000+ happy customers. Fast shipping guaranteed.',
    cta:         'Shop Now',
    audience:    { age: '25-45', interests: ['shopping'], income: 'mid' },
    keywords:    ['buy online', 'best deal'],
  }),
  [NVIDIA_253B_MODEL]: JSON.stringify({
    decision:                'HOLD',
    reasoning:               'Mock strategy — insufficient real data.',
    recommended_budget_delta: 0,
    confidence:              50,
  }),
};

@Injectable()
export class NvidiaService {
  private readonly logger = new Logger(NvidiaService.name);

  constructor(private readonly vault: ConfigVaultService) {}

  async call(opts: NvidiaCallOptions): Promise<NvidiaCallResult> {
    const baseUrl = await this.vault.get('NVIDIA_BASE_URL')
      ?? 'https://integrate.api.nvidia.com/v1';

    const apiKey = opts.model === NVIDIA_253B_MODEL
      ? await this.vault.get('NVIDIA_253B_API_KEY')
      : await this.vault.get('NVIDIA_49B_API_KEY');

    // MOCK MODE: no key configured
    if (!apiKey || apiKey.startsWith('mock')) {
      this.logger.debug(`[NVIDIA MOCK] ${opts.model} — no key configured`);
      return this.mockResult(opts);
    }

    const start = Date.now();

    try {
      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model:       opts.model,
          messages:    opts.messages,
          temperature: opts.temperature ?? 0.7,
          max_tokens:  opts.maxTokens   ?? 1500,
        },
        {
          headers: {
            Authorization:  `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 45_000,
        },
      );

      const latencyMs = Date.now() - start;
      const choice    = response.data.choices[0];
      const usage     = response.data.usage;

      this.logger.debug(
        `[NVIDIA] ${opts.model} responded in ${latencyMs}ms ` +
        `(tokens: ${usage.total_tokens as number})`,
      );

      return {
        content:  choice.message.content as string,
        model:    opts.model,
        usage: {
          promptTokens:     usage.prompt_tokens     as number,
          completionTokens: usage.completion_tokens as number,
          totalTokens:      usage.total_tokens      as number,
        },
        latencyMs,
      };
    } catch (err) {
      this.logger.error(
        `[NVIDIA] ${opts.model} call failed after ${Date.now() - start}ms: ${(err as Error).message}`,
      );
      throw err; // Bubble up so circuit breaker can record failure
    }
  }

  call49B(messages: NvidiaMessage[], temperature = 0.7, maxTokens = 1500) {
    return this.call({ model: NVIDIA_49B_MODEL, messages, temperature, maxTokens });
  }

  call253B(messages: NvidiaMessage[], temperature = 0.4, maxTokens = 2000) {
    return this.call({ model: NVIDIA_253B_MODEL, messages, temperature, maxTokens });
  }

  private mockResult(opts: NvidiaCallOptions): NvidiaCallResult {
    return {
      content:   MOCK_RESPONSE[opts.model] ?? '{}',
      model:     opts.model,
      usage:     { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      latencyMs: 50,
    };
  }
}
