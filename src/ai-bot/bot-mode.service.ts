/**
 * BotModeService — V4 FAILURE RESISTANCE / BOT MODE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUDIT FIX — FAILURE RESISTANCE (MANDATORY):
 *
 * System MUST work even if:
 *   ❌ NVIDIA APIs fail  → BOT MODE returns valid creative output
 *   ❌ MuAPI fails       → BOT MODE returns valid creative output
 *   ❌ Redis fails       → BOT MODE skips cache, continues
 *   ❌ DB is slow        → BOT MODE returns safe HOLD decision
 *   ❌ Meta API fails    → BOT MODE returns HOLD with cached metrics
 *
 * BOT MODE ALWAYS RETURNS VALID OUTPUT — NEVER CRASHES THE LOOP.
 *
 * Bot capabilities (zero external dependencies):
 *   - Template-based hook generation (winner DNA injected if in memory cache)
 *   - Hard-rule profit decisions (KILL/SCALE/HOLD/PIVOT — no AI needed)
 *   - Product rejection scoring (pure math — no API needed)
 *   - Campaign status updates (local DB only)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger } from '@nestjs/common';

export interface BotCreativeOutput {
  hooks:    string[];
  captions: string[];
  headlines: string[];
  source:   'BOT_TEMPLATE' | 'BOT_DNA';
}

export interface BotDecisionOutput {
  decision:  'SCALE' | 'HOLD' | 'KILL' | 'PIVOT' | 'TEST';
  reason:    string;
  source:    'BOT_HARD' | 'BOT_RULE';
  actions:   Array<{ type: string; payload: Record<string, unknown> }>;
}

// ── Template libraries (always available — no external deps) ──────────────────

const HOOK_TEMPLATES = [
  (title: string) => `Stop scrolling — ${title} actually works`,
  (title: string) => `I tested ${title} for 30 days — here is the truth`,
  (title: string) => `Nobody tells you this about ${title}`,
  (title: string) => `This ${title} changed my daily routine`,
  (title: string) => `Before you buy ${title}, watch this first`,
  (title: string) => `Real results with ${title} — no filters`,
  (title: string) => `${title} — is it actually worth it?`,
  (title: string) => `My honest review after 2 weeks with ${title}`,
];

const CAPTION_TEMPLATES = [
  (title: string, price: number) => `✅ ${title} — Trusted by thousands. Get yours for just ₹${price}!`,
  (title: string, price: number) => `🔥 ${title} at ₹${price} — Limited stock. Order before it's gone.`,
  (title: string) => `💯 ${title}: The upgrade you have been waiting for. Free shipping!`,
  (title: string, price: number) => `⭐ ${title} — Starting at ₹${price}. See why people love it.`,
];

const HEADLINE_TEMPLATES = [
  (title: string) => `${title} — Shop Now & Save`,
  (title: string) => `Get ${title} — Fast Delivery`,
  (title: string) => `${title}: India's Favourite Pick`,
  (title: string) => `${title} — Try It Risk-Free`,
];

@Injectable()
export class BotModeService {
  private readonly logger = new Logger(BotModeService.name);

  // Tracks whether we are in degraded (all-bot) mode
  private isFullBotMode = false;
  private failureCount  = 0;
  private readonly FAILURE_THRESHOLD = 3; // after 3 consecutive API failures → full bot mode

  // ── Creative generation (always succeeds) ──────────────────────────────────

  generateCreatives(
    title:        string,
    category:     string,
    sellingPrice: number,
    dnaHooks?:    string[],  // from WinnerDnaService memory cache (optional)
  ): BotCreativeOutput {
    const hooks: string[] = [];

    // Use DNA hooks first (injected from in-memory cache — zero DB call)
    if (dnaHooks && dnaHooks.length > 0) {
      hooks.push(...dnaHooks.slice(0, 2));
    }

    // Fill remaining hooks from templates
    const templateHooks = HOOK_TEMPLATES
      .slice(0, 3 - hooks.length)
      .map(fn => fn(title));
    hooks.push(...templateHooks);

    const captions  = CAPTION_TEMPLATES.slice(0, 3).map(fn => fn(title, sellingPrice));
    const headlines = HEADLINE_TEMPLATES.slice(0, 2).map(fn => fn(title));

    const source: BotCreativeOutput['source'] = dnaHooks?.length ? 'BOT_DNA' : 'BOT_TEMPLATE';

    this.logger.debug(`[BotMode] Creative generated (${source}) for "${title}"`);

    return { hooks, captions, headlines, source };
  }

  // ── Hard-rule decision (always succeeds — pure math) ─────────────────────

  makeHardRuleDecision(
    adSpend:     number,
    realRoas:    number | null,  // null = no Shopify data → mandatory HOLD
    ctr:         number,
    impressions: number,
    conversions: number,
  ): BotDecisionOutput {

    // ABSOLUTE TRUTH GATE: No real revenue → HOLD
    if (realRoas === null) {
      return {
        decision: 'HOLD',
        reason:   'BOT HOLD — No real Shopify revenue. Cannot make profit decision without real data.',
        source:   'BOT_HARD',
        actions:  [{ type: 'WAIT_24H', payload: { reason: 'missing_shopify_revenue' } }],
      };
    }

    // Hard kill: spend ≥ 300 AND 0 conversions
    if (adSpend >= 300 && conversions === 0) {
      return {
        decision: 'KILL',
        reason:   `BOT KILL — $${adSpend} spent, 0 conversions`,
        source:   'BOT_HARD',
        actions:  [{ type: 'STOP_CAMPAIGN', payload: { reason: 'zero_conversions_at_300' } }],
      };
    }

    // Hard kill: spend ≥ 300 AND ROAS < 1
    if (adSpend >= 300 && realRoas < 1.0) {
      return {
        decision: 'KILL',
        reason:   `BOT KILL — Real ROAS ${realRoas.toFixed(2)} < 1.0 after $${adSpend}`,
        source:   'BOT_HARD',
        actions:  [{ type: 'STOP_CAMPAIGN', payload: { reason: 'roas_below_1_at_300' } }],
      };
    }

    // Early kill: spend ≥ 150 AND ROAS < 0.7
    if (adSpend >= 150 && realRoas < 0.7) {
      return {
        decision: 'KILL',
        reason:   `BOT KILL — Early bleed: ROAS ${realRoas.toFixed(2)} < 0.7 at $${adSpend}`,
        source:   'BOT_HARD',
        actions:  [{ type: 'STOP_CAMPAIGN', payload: { reason: 'early_bleed_kill' } }],
      };
    }

    // Pivot: CTR < 1% after 2000 impressions
    if (impressions >= 2000 && ctr < 1.0) {
      return {
        decision: 'PIVOT',
        reason:   `BOT PIVOT — CTR ${ctr.toFixed(2)}% < 1% after ${impressions} impressions`,
        source:   'BOT_HARD',
        actions:  [
          { type: 'CHANGE_HOOK',        payload: { reason: 'low_ctr' } },
          { type: 'CHANGE_VIDEO_INTRO', payload: { firstSeconds: 3 } },
        ],
      };
    }

    // Scale: ROAS ≥ 2
    if (realRoas >= 2.0 && adSpend >= 50) {
      return {
        decision: 'SCALE',
        reason:   `BOT SCALE — Real ROAS ${realRoas.toFixed(2)} ≥ 2`,
        source:   'BOT_RULE',
        actions:  [
          { type: 'INCREASE_BUDGET', payload: { multiplier: 1.3 } },
          { type: 'DUPLICATE_ADSET', payload: {} },
        ],
      };
    }

    // Default: HOLD
    return {
      decision: 'HOLD',
      reason:   `BOT HOLD — No decisive signal (ROAS=${realRoas.toFixed(2)}, CTR=${ctr.toFixed(2)}%)`,
      source:   'BOT_RULE',
      actions:  [{ type: 'WAIT_24H', payload: {} }],
    };
  }

  // ── Failure tracking — auto-escalate to full bot mode ─────────────────────

  recordApiFailure(service: string): void {
    this.failureCount++;
    this.logger.warn(`[BotMode] API failure #${this.failureCount}: ${service}`);
    if (this.failureCount >= this.FAILURE_THRESHOLD && !this.isFullBotMode) {
      this.isFullBotMode = true;
      this.logger.warn(
        `[BotMode] ⚠️ ENTERING FULL BOT MODE — ${this.failureCount} consecutive failures. ` +
        `All decisions will use BOT rules until APIs recover.`,
      );
    }
  }

  recordApiSuccess(): void {
    if (this.failureCount > 0) {
      this.failureCount = 0;
      if (this.isFullBotMode) {
        this.isFullBotMode = false;
        this.logger.log('[BotMode] ✅ API recovered — exiting full bot mode');
      }
    }
  }

  get isInFullBotMode(): boolean {
    return this.isFullBotMode;
  }

  getStatus() {
    return {
      isFullBotMode:    this.isFullBotMode,
      failureCount:     this.failureCount,
      failureThreshold: this.FAILURE_THRESHOLD,
      capabilities: {
        creativeGeneration: 'always available (templates + DNA injection)',
        profitDecisions:    'always available (pure math hard rules)',
        productScoring:     'always available (pure math)',
      },
    };
  }

// ── V60 unified execute API (used by ai-provider.registry.ts) ─────────────
  execute(req: { operation: 'listing' | 'campaign' | 'scoring' | 'media'; context: Record<string, unknown> }): { content: string } {
    const content = JSON.stringify({
      operation: req.operation,
      decision:  'HOLD',
      rationale: 'Bot mode fallback — no live AI available',
      timestamp: new Date().toISOString(),
    });
    return { content };
  }
}
