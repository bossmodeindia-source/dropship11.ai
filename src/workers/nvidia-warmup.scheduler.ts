/**
 * NvidiaWarmupScheduler — NEW FILE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX #8 — 253B WARMUP JOB (prevents cold-start timeouts)
 *
 *   PROBLEM:
 *     NVIDIA 253B GPU containers cold-start in ~8–12s after idle.
 *     First call in a cycle frequently hit the old 5s timeout → forced HOLD.
 *     Campaigns that should SCALE were stuck in HOLD for 24h.
 *
 *   SOLUTION:
 *     Send a minimal "ping" prompt to 253B every 30 minutes.
 *     Cost: ~5 tokens per warmup call, ~$0.0002/call → ~$0.01/day.
 *     Benefit: eliminates cold-start latency for all subsequent real calls.
 *
 *   IMPLEMENTATION:
 *     @Cron('0 *\/30 * * * *') — every 30 minutes, on the :00 second
 *     Uses AiProviderRegistry.get253B() directly — bypasses orchestrator
 *     routing, cache, guard, quota — pure keep-alive, not a real AI call.
 *     Wrapped in try/catch — warmup failure NEVER affects the main loop.
 *
 *   Combined with FIX #8 timeout increase (5s → 10s):
 *     Even on rare cold-start, 10s ceiling covers P99 GPU wake latency.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AiProviderRegistry } from '../ai-orchestrator/ai-provider.registry';

@Injectable()
export class NvidiaWarmupScheduler {
  private readonly logger = new Logger(NvidiaWarmupScheduler.name);

  constructor(private readonly registry: AiProviderRegistry) {}

  /**
   * Warmup ping every 30 minutes.
   * Sends 5-token prompt to 253B to keep GPU container warm.
   * Cost: ~$0.01/day. Benefit: eliminates cold-start HOLD decisions.
   */
  @Cron('0 */30 * * * *')
  async warmup253B(): Promise<void> {
    try {
      const provider = this.registry.get253B();
      await provider.generate({
        messages: [
          { role: 'system', content: 'You are a warmup ping.' },
          { role: 'user',   content: 'ping' },
        ],
        operation:   'strategy',
        context:     {},
        temperature: 0,
        maxTokens:   3,  // Absolute minimum — just wake the container
      });
      this.logger.debug('[Warmup] 253B ping OK — GPU container is warm');
    } catch (err) {
      // Warmup failure is non-critical — log and continue
      this.logger.debug(`[Warmup] 253B ping failed (non-critical): ${(err as Error).message}`);
    }
  }
}
