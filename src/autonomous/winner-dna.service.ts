/**
 * WinnerDnaService — PHASE 5: SELF-LEARNING PROFIT MEMORY
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TASK 8: Activate Winner DNA — store on every SCALE, inject everywhere
 *
 * ON EVERY SCALE DECISION, STORE:
 *   hook            → the exact hook text that drove conversions
 *   creativeType    → video | image | carousel
 *   niche           → product niche / category
 *   price           → selling price that worked
 *   audience        → Meta targeting params
 *   realRoas        → verified Shopify ROAS
 *   netProfit       → actual profit after COGS
 *   ctr             → click-through rate
 *   conversions     → number of purchases
 *
 * INJECT INTO:
 *   ├── Product selection scoring (niche affinity boost)
 *   ├── Creative generation prompts (successful hooks as examples)
 *   ├── Audience targeting (copy winning audience settings)
 *   └── Pricing strategy (price points that convert)
 *
 * DNA QUALITY GATES:
 *   Only store winners with ROAS ≥ 2.0 AND CTR ≥ 2%
 *   Stale DNA (> 30 days) gets auto-archived
 *   Max 100 active DNA records (quality over quantity)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export interface WinnerDna {
  id:                  string;
  campaignId:          string;
  hook:                string;
  creativeType:        string;
  niche:               string;
  category?:           string;
  price:               number;
  priceRangeMin?:      number;
  priceRangeMax?:      number;
  audience:            Record<string, unknown>;
  realRoas:            number;
  netProfit:           number;
  ctr:                 number;
  avgCtr?:             number;
  avgRoas?:            number;
  conversions:         number;
  adSpend:             number;
  storedAt:            Date;
  usageCount:          number;
  sampleSize?:         number;
  source:              string;
  winningAngle?:       string;
  winningHookPatterns?: string[];
}

export interface DnaInjectionContext {
  topHooks:        string[];        // Inject into creative prompts
  winningNiches:   string[];        // Boost in product scoring
  winningPrices:   number[];        // Price anchors that converted
  audiencePatterns: Record<string, unknown>[];  // Copy these targeting configs
  avgWinnerRoas:   number;
  avgWinnerCtr:    number;
}

// DNA quality gates
const MIN_ROAS_FOR_DNA      = 2.0;
const MIN_CTR_FOR_DNA       = 2.0;
const MAX_ACTIVE_DNA        = 100;
const DNA_CACHE_TTL_MS      = 10 * 60 * 1000; // 10 min cache

@Injectable()
export class WinnerDnaService {
  private readonly logger = new Logger(WinnerDnaService.name);
  private dnaCache:     WinnerDna[] | null = null;
  private dnaCacheAt:   number = 0;

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * TASK 8 CORE: Store winner DNA on every SCALE decision.
   * Called by OptimizationScheduler when STORE_WINNER_DNA action is received.
   */
  async storeWinner(payload: {
    campaignId:    string;
    hook:          string;
    creativeType:  string;
    niche:         string;
    price:         number;
    audience?:     Record<string, unknown>;
    realRoas:      number;
    netProfit:     number;
    ctr:           number;
    conversions:   number;
    adSpend:       number;
    source?:       string;
  }): Promise<void> {
    // Quality gate — only real winners
    if (payload.realRoas < MIN_ROAS_FOR_DNA) {
      this.logger.debug(
        `[WinnerDNA] Skipping DNA store — ROAS ${payload.realRoas.toFixed(2)} < ${MIN_ROAS_FOR_DNA}`,
      );
      return;
    }
    if (payload.ctr < MIN_CTR_FOR_DNA) {
      this.logger.debug(
        `[WinnerDNA] Skipping DNA store — CTR ${payload.ctr.toFixed(2)}% < ${MIN_CTR_FOR_DNA}%`,
      );
      return;
    }

    try {
      await this.db.execute(sql`
        INSERT INTO winner_dna (
          campaign_id, hook, creative_type, niche, price,
          audience, real_roas, net_profit, ctr, conversions,
          ad_spend, source, usage_count, stored_at
        ) VALUES (
          ${payload.campaignId},
          ${payload.hook},
          ${payload.creativeType ?? 'unknown'},
          ${payload.niche},
          ${payload.price},
          ${JSON.stringify(payload.audience ?? {})},
          ${payload.realRoas},
          ${payload.netProfit},
          ${payload.ctr},
          ${payload.conversions},
          ${payload.adSpend},
          ${payload.source ?? 'BOT_SCORE'},
          0,
          NOW()
        )
      `);

      // Invalidate cache
      this.dnaCache  = null;
      this.dnaCacheAt = 0;

      this.logger.log(
        `[WinnerDNA] ✅ Stored winner | campaign=${payload.campaignId} | ` +
        `niche=${payload.niche} | ROAS=${payload.realRoas.toFixed(2)} | ` +
        `CTR=${payload.ctr.toFixed(2)}% | hook="${payload.hook.slice(0, 50)}"`,
      );

      // Prune old DNA records (keep max 100)
      await this.pruneOldDna();
    } catch (err) {
      this.logger.error(`[WinnerDNA] Store failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get top N winner DNA records (cached for 10 min).
   * Used by creative generation and product scoring.
   */
  async getTopDna(limit = 10): Promise<WinnerDna[]> {
    const now = Date.now();
    if (this.dnaCache && (now - this.dnaCacheAt) < DNA_CACHE_TTL_MS) {
      return this.dnaCache.slice(0, limit);
    }

    try {
      const rows = await this.db.execute(sql`
        SELECT
          id, campaign_id, hook, creative_type, niche, price,
          audience, real_roas, net_profit, ctr, conversions,
          ad_spend, source, usage_count, stored_at
        FROM winner_dna
        WHERE stored_at >= NOW() - INTERVAL '30 days'
        ORDER BY real_roas DESC, ctr DESC
        LIMIT ${MAX_ACTIVE_DNA}
      `) as unknown as Array<{
        id: string; campaign_id: string; hook: string; creative_type: string;
        niche: string; price: string; audience: unknown; real_roas: string;
        net_profit: string; ctr: string; conversions: string; ad_spend: string;
        source: string; usage_count: string; stored_at: string;
      }>;

      this.dnaCache = rows.map(r => ({
        id:           r.id,
        campaignId:   r.campaign_id,
        hook:         r.hook,
        creativeType: r.creative_type,
        niche:        r.niche,
        price:        parseFloat(r.price ?? '0'),
        audience:     (typeof r.audience === 'object' ? r.audience : {}) as Record<string, unknown>,
        realRoas:     parseFloat(r.real_roas ?? '0'),
        netProfit:    parseFloat(r.net_profit ?? '0'),
        ctr:          parseFloat(r.ctr ?? '0'),
        conversions:  parseInt(r.conversions ?? '0', 10),
        adSpend:      parseFloat(r.ad_spend ?? '0'),
        source:       r.source,
        usageCount:   parseInt(r.usage_count ?? '0', 10),
        storedAt:     new Date(r.stored_at),
      }));

      this.dnaCacheAt = now;
      return this.dnaCache.slice(0, limit);
    } catch (err) {
      this.logger.error(`[WinnerDNA] getTopDna failed: ${(err as Error).message}`);
      return this.dnaCache?.slice(0, limit) ?? [];
    }
  }

  /**
   * TASK 8: Build injection context for creative generation and product scoring.
   * This is what gets injected into every AI prompt and product score calculation.
   */
  async buildInjectionContext(): Promise<DnaInjectionContext> {
    const dna = await this.getTopDna(20);

    if (dna.length === 0) {
      return {
        topHooks:         [],
        winningNiches:    [],
        winningPrices:    [],
        audiencePatterns: [],
        avgWinnerRoas:    0,
        avgWinnerCtr:     0,
      };
    }

    // Extract top hooks (deduped, ordered by ROAS)
    const hooksSeen = new Set<string>();
    const topHooks  = dna
      .filter(d => d.hook && !hooksSeen.has(d.hook) && hooksSeen.add(d.hook))
      .slice(0, 5)
      .map(d => d.hook);

    // Winning niches (sorted by frequency × avg ROAS)
    const nicheMap = new Map<string, { count: number; totalRoas: number }>();
    for (const d of dna) {
      const n = nicheMap.get(d.niche) ?? { count: 0, totalRoas: 0 };
      n.count++;
      n.totalRoas += d.realRoas;
      nicheMap.set(d.niche, n);
    }
    const winningNiches = [...nicheMap.entries()]
      .sort((a, b) => (b[1].totalRoas / b[1].count) - (a[1].totalRoas / a[1].count))
      .map(([niche]) => niche)
      .slice(0, 10);

    // Winning price points
    const winningPrices = [...new Set(dna.map(d => d.price))]
      .sort((a, b) => a - b)
      .slice(0, 8);

    // Audience patterns (top performers' targeting)
    const audiencePatterns = dna
      .filter(d => Object.keys(d.audience).length > 0)
      .slice(0, 5)
      .map(d => d.audience);

    const avgWinnerRoas = dna.reduce((s, d) => s + d.realRoas, 0) / dna.length;
    const avgWinnerCtr  = dna.reduce((s, d) => s + d.ctr, 0) / dna.length;

    // Increment usage count
    void this.incrementUsageCount(dna.slice(0, 10).map(d => d.id));

    return {
      topHooks,
      winningNiches,
      winningPrices,
      audiencePatterns,
      avgWinnerRoas: parseFloat(avgWinnerRoas.toFixed(2)),
      avgWinnerCtr:  parseFloat(avgWinnerCtr.toFixed(2)),
    };
  }

  /**
   * Check if a niche has previous winners — used by product scoring.
   * Returns affinity score 0–1 (1 = niche has multiple high-ROAS winners).
   */
  async getNicheAffinity(niche: string): Promise<number> {
    const dna = await this.getTopDna(50);
    const matches = dna.filter(d =>
      d.niche.toLowerCase().includes(niche.toLowerCase()) ||
      niche.toLowerCase().includes(d.niche.toLowerCase()),
    );
    if (matches.length === 0) return 0;
    const avgRoas = matches.reduce((s, d) => s + d.realRoas, 0) / matches.length;
    return Math.min(avgRoas / 4, 1); // Normalize: ROAS 4 → 1.0 affinity
  }

  /**
   * Build DNA injection string for AI creative prompts.
   */
  async buildCreativePromptInjection(): Promise<string> {
    const ctx = await this.buildInjectionContext();
    if (ctx.topHooks.length === 0) return '';

    return [
      '=== PROVEN WINNER HOOKS (inject DNA from real converters) ===',
      ...ctx.topHooks.map((h, i) => `${i + 1}. "${h}"`),
      '',
      `Winning niches: ${ctx.winningNiches.slice(0, 5).join(', ')}`,
      `Winning price points: ₹${ctx.winningPrices.join(', ₹')}`,
      `Avg winner ROAS: ${ctx.avgWinnerRoas.toFixed(2)}x | Avg CTR: ${ctx.avgWinnerCtr.toFixed(2)}%`,
      '=== END DNA ===',
    ].join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async pruneOldDna(): Promise<void> {
    try {
      // Archive records older than 30 days or beyond max count
      await this.db.execute(sql`
        UPDATE winner_dna SET archived = true
        WHERE id IN (
          SELECT id FROM winner_dna
          WHERE archived = false
          ORDER BY real_roas DESC, stored_at DESC
          OFFSET ${MAX_ACTIVE_DNA}
        )
      `);
    } catch { /* non-critical */ }
  }

  private async incrementUsageCount(ids: string[]): Promise<void> {
    if (!ids.length) return;
    try {
      const idList = ids.map(id => `'${id}'`).join(',');
      await this.db.execute(sql`
        UPDATE winner_dna SET usage_count = usage_count + 1
        WHERE id IN (${sql.raw(idList)})
      `);
    } catch { /* non-critical */ }
  }
  /** Get top niches ranked by win rate */
  async getTopNiches(limit = 5): Promise<{ name: string; category: string; score: number }[]> {
    const dna = await this.getTopDna(limit * 3);
    const map = new Map<string, { count: number; roas: number }>();
    for (const d of dna) {
      const key = d.niche;
      const existing = map.get(key) ?? { count: 0, roas: 0 };
      map.set(key, { count: existing.count + 1, roas: existing.roas + d.realRoas });
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, category: name, score: v.roas / v.count }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Get DNA record by id */
  async getDna(id: string, _price?: number): Promise<WinnerDna | null> {
    const all = await this.getTopDna(1000);
    return all.find(d => d.id === id) ?? null;
  }

  /** Get DNA records filtered by category/niche */
  async getDnaForCategory(category: string): Promise<WinnerDna[]> {
    const all = await this.getTopDna(1000);
    return all.filter(d => d.niche === category || d.category === category);
  }

  /** Build prompt injection string (alias for buildCreativePromptInjection) */
  async getPromptInjection(_category?: string, _retailPrice?: number): Promise<string> {
    return this.buildCreativePromptInjection();
  }

  /** Inject creative pattern into a prompt string */
  async injectCreativePattern(prompt: string): Promise<string> {
    const injection = await this.buildCreativePromptInjection();
    return `${prompt}

Winner patterns:
${injection}`;
  }

  /** Get top performing hooks for a given category */
  async getTopHooksForCategory(category: string, limit = 5): Promise<string[]> {
    const dna = await this.getDnaForCategory(category);
    return dna
      .sort((a, b) => b.ctr - a.ctr)
      .slice(0, limit)
      .map(d => d.hook);
  }
}

export interface RankedNiche { name: string; category: string; score: number }
