/**
 * NemoGuardService (V2 — Updated)
 *
 * Reads NEMOGUARD_API_KEY from ConfigVaultService — zero process.env access.
 * Behaviour unchanged: fails open (safe=true) on API errors so a guard
 * outage never blocks the pipeline.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigVaultService } from '../../config-vault/config-vault.service';

export interface SafetyResult {
  safe:      boolean;
  reason:    'clean' | 'jailbreak_detected' | 'api_error' | 'mock' | 'no_key';
  latencyMs: number;
}

@Injectable()
export class NemoGuardService {
  private readonly logger = new Logger(NemoGuardService.name);

  constructor(private readonly vault: ConfigVaultService) {}

  /**
   * Returns { safe: true } on API errors or missing key —
   * guard outage must never block the AI pipeline.
   */
  async check(text: string): Promise<SafetyResult> {
    const [apiKey, baseUrl] = await Promise.all([
      this.vault.get('NEMOGUARD_API_KEY'),
      this.vault.get('NVIDIA_BASE_URL'),
    ]);

    const resolvedUrl = baseUrl ?? 'https://integrate.api.nvidia.com/v1';

    if (!apiKey || apiKey.startsWith('mock')) {
      return { safe: true, reason: 'no_key', latencyMs: 0 };
    }

    const start = Date.now();

    try {
      const response = await axios.post(
        `${resolvedUrl}/chat/completions`,
        {
          model:       'nvidia/nemoguard-jailbreak-detect',
          messages:    [{ role: 'user', content: text }],
          max_tokens:  10,
          temperature: 0,
        },
        {
          headers: {
            Authorization:  `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 8_000,
        },
      );

      const latencyMs = Date.now() - start;
      const raw       = (
        response.data?.choices?.[0]?.message?.content as string ?? ''
      ).toLowerCase().trim();

      if (raw.includes('jailbreak') || raw.includes('unsafe')) {
        this.logger.warn(`[NemoGuard] Unsafe content (${latencyMs}ms) — BOT fallback`);
        return { safe: false, reason: 'jailbreak_detected', latencyMs };
      }

      return { safe: true, reason: 'clean', latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      this.logger.error(
        `[NemoGuard] API error after ${latencyMs}ms — defaulting safe: ${(err as Error).message}`,
      );
      return { safe: true, reason: 'api_error', latencyMs };
    }
  }
}
