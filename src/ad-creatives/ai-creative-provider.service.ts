import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { ProductContext, AdCreativeBundle, VideoScript } from './template-engine';
import { buildCreativeBundle } from './template-engine';

interface OpenAIMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIChoice {
  message: { content: string };
}

interface OpenAIUsage {
  prompt_tokens:     number;
  completion_tokens: number;
  total_tokens:      number;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage:   OpenAIUsage;
  model:   string;
}

export interface CreativeResult {
  bundle:      AdCreativeBundle;
  aiGenerated: boolean;
  model:       string;
  usage?:      { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs:   number;
}

const SYSTEM_PROMPT = `You are an expert performance-marketing copywriter specialising in
short-form social ads (Facebook, Instagram, TikTok) for dropshipping products.

Your output MUST be valid JSON matching EXACTLY this schema — no extra keys, no markdown:

{
  "hooks":    [string, string, string],
  "captions": [string, string, string],
  "headlines":[string, string],
  "videoScript": {
    "hook":     string,
    "problem":  string,
    "solution": string,
    "cta":      string
  }
}

Rules:
- hooks:     3 short scroll-stopping openers (max 120 chars each)
- captions:  3 ad body texts at different lengths/tones (short, medium, long)
- headlines: 2 concise headlines ≤ 60 chars for Meta ad headline field
- videoScript.hook:     first 3-second hook line
- videoScript.problem:  pain point the product solves (1–2 sentences)
- videoScript.solution: product pitch + key benefits (2–3 sentences)
- videoScript.cta:      closing call-to-action (1 sentence)`;

@Injectable()
export class AiCreativeProviderService {
  private readonly logger  = new Logger(AiCreativeProviderService.name);
  private readonly apiKey:  string;
  private readonly baseUrl: string;
  private readonly isMock:  boolean;

  constructor(private readonly config: ConfigService) {
    this.apiKey  = this.config.get<string>('OPENAI_API_KEY', '');
    this.baseUrl = this.config.get<string>('OPENAI_BASE_URL', 'https://api.openai.com/v1');
    // Treat missing, 'mock', or placeholder values as "no real key"
    this.isMock  =
      !this.apiKey ||
      this.apiKey === 'mock' ||
      this.apiKey === 'sk-mock' ||
      this.apiKey.startsWith('sk-mock');
  }

  get hasRealKey(): boolean {
    return !this.isMock;
  }

  async generate(product: ProductContext): Promise<CreativeResult> {
    if (this.isMock) {
      return this.templateFallback(product);
    }

    try {
      return await this.callOpenAI(product);
    } catch (err) {
      // Safety: any API failure → fall back to templates, log only
      this.logger.error(
        `OpenAI creative generation failed — falling back to templates: ${(err as Error).message}`,
      );
      return this.templateFallback(product);
    }
  }

  // ── OpenAI path ───────────────────────────────────────────────────────────

  private async callOpenAI(product: ProductContext): Promise<CreativeResult> {
    const model       = 'gpt-4o-mini';
    const userMessage = this.buildUserPrompt(product);
    const messages: OpenAIMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ];

    const start = Date.now();

    const response = await axios.post<OpenAIResponse>(
      `${this.baseUrl}/chat/completions`,
      {
        model,
        messages,
        temperature:  0.8,
        max_tokens:   1200,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization:  `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );

    const latencyMs = Date.now() - start;
    const raw       = response.data.choices[0].message.content;
    const usage     = response.data.usage;

    const bundle = this.parseBundle(raw, product);

    this.logger.log(
      `AI creatives generated – model=${model} ` +
      `tokens=${usage.total_tokens} latency=${latencyMs}ms`,
    );

    return {
      bundle,
      aiGenerated: true,
      model,
      usage: {
        promptTokens:     usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens:      usage.total_tokens,
      },
      latencyMs,
    };
  }

  private buildUserPrompt(p: ProductContext): string {
    return (
      `Generate ad creatives for this dropshipping product:\n\n` +
      `Title:       ${p.title}\n` +
      `Category:    ${p.category ?? 'General'}\n` +
      `Price:       ${p.sellingPrice ? `$${p.sellingPrice}` : 'not specified'}\n` +
      `Description: ${p.description?.slice(0, 200) ?? 'N/A'}\n` +
      `Tags:        ${p.tags.join(', ') || 'none'}`
    );
  }

  private parseBundle(raw: string, fallbackProduct: ProductContext): AdCreativeBundle {
    try {
      const parsed = JSON.parse(raw) as Partial<AdCreativeBundle>;

      // Validate each field — fall back to template for any missing piece
      const fallback = buildCreativeBundle(fallbackProduct);

      const hooks = this.ensureStringArray(parsed.hooks, 3)
        ?? fallback.hooks;

      const captions = this.ensureStringArray(parsed.captions, 3)
        ?? fallback.captions;

      const headlines = this.ensureStringArray(parsed.headlines, 2) as [string, string]
        ?? fallback.headlines;

      const videoScript: VideoScript =
        this.isValidVideoScript(parsed.videoScript)
          ? (parsed.videoScript as VideoScript)
          : fallback.videoScript;

      return {
        hooks:       hooks as [string, string, string],
        captions:    captions as [string, string, string],
        headlines:   headlines as [string, string],
        videoScript,
      };
    } catch {
      this.logger.warn('Failed to parse AI JSON — using template bundle');
      return buildCreativeBundle(fallbackProduct);
    }
  }

  private ensureStringArray(
    arr: unknown,
    minLength: number,
  ): string[] | null {
    if (
      !Array.isArray(arr) ||
      arr.length < minLength ||
      arr.some((x) => typeof x !== 'string')
    ) {
      return null;
    }
    return arr as string[];
  }

  private isValidVideoScript(vs: unknown): boolean {
    if (!vs || typeof vs !== 'object') return false;
    const v = vs as Record<string, unknown>;
    return (
      typeof v.hook     === 'string' &&
      typeof v.problem  === 'string' &&
      typeof v.solution === 'string' &&
      typeof v.cta      === 'string'
    );
  }

  // ── Template fallback ─────────────────────────────────────────────────────

  private templateFallback(product: ProductContext): CreativeResult {
    const start = Date.now();
    const bundle = buildCreativeBundle(product);
    this.logger.debug(
      `Template creatives generated for "${product.title}" (no AI key)`,
    );
    return {
      bundle,
      aiGenerated: false,
      model:       'template',
      latencyMs:   Date.now() - start,
    };
  }
}
