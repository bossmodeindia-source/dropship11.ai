/**
 * NicheDominationService — PHASE 3 STEP 3
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 *   When 1 product wins → dominate the entire niche, not just that product.
 *   Uses WinnerDNA to extract the niche profile of a winner, then
 *   instructs ProductDiscoveryService to find related products in that niche.
 *
 * LOGIC
 *   1. On each SCALE decision, extract niche from winning product
 *   2. Query niche expansion map (hardcoded + AI-generated adjacencies)
 *   3. Return "expansion targets" to the autonomous loop for immediate launch
 *   4. Track domination coverage per niche (how many products active vs total)
 *
 * EXAMPLE
 *   Winning: "posture corrector"
 *   Expands: ["back support belt", "ergonomic pillow", "spine stretcher",
 *             "lumbar cushion", "posture shirt"]
 *
 * INTEGRATION
 *   UnifiedCommerceOrchestrator triggers this after every SCALE event.
 *   Results are passed to ProductDiscoveryService.searchProductsInNiche().
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NicheExpansionTarget {
  keyword:       string;
  category:      string;
  sourceWinner:  string;   // product title of the winning product
  priority:      'HIGH' | 'MEDIUM';
  rationale:     string;
}

export interface NicheDominationPlan {
  winnerProductId:   string;
  winnerProductTitle: string;
  winnerCategory:    string;
  winnerRoas:        number;
  expansionTargets:  NicheExpansionTarget[];
  alreadyCovered:    string[];   // keywords already being tested/run
  generatedAt:       Date;
}

// ── Static niche adjacency map (Phase 3 seed — system expands from DB/DNA over time) ──

const NICHE_ADJACENCY: Record<string, string[]> = {
  // Health & Wellness
  'posture corrector':    ['back support belt', 'ergonomic pillow', 'spine stretcher', 'lumbar cushion', 'posture shirt'],
  'knee brace':           ['ankle support', 'elbow brace', 'wrist support', 'joint pain relief', 'compression socks'],
  'back pain relief':     ['posture corrector', 'heating pad', 'massage gun', 'lumbar support', 'back stretcher'],
  'massage gun':          ['foam roller', 'muscle roller', 'percussive massager', 'back massager', 'neck massager'],
  'sleep mask':           ['white noise machine', 'earplugs sleeping', 'weighted blanket', 'blackout curtains', 'pillow mist'],
  'fitness resistance band': ['pull up assist band', 'booty band', 'pilates ring', 'ab roller', 'jump rope'],

  // Beauty & Skin
  'led face mask':        ['red light therapy wand', 'microcurrent face lift', 'gua sha tool', 'jade roller', 'eye massager'],
  'hair growth serum':    ['scalp massager', 'biotin supplement', 'hair mask', 'derma roller hair', 'bamboo hair brush'],
  'jade roller':          ['gua sha stone', 'facial roller', 'ice roller face', 'face lifting tool', 'eye massager'],

  // Kitchen & Home
  'portable blender':     ['smoothie cup', 'protein shaker', 'electric whisk', 'food processor mini', 'juicer portable'],
  'air fryer':            ['air fryer accessories', 'silicone baking mat', 'oil mister spray', 'oven thermometer', 'kitchen scale'],
  'kitchen organiser':    ['drawer dividers', 'pantry containers', 'spice rack', 'fridge organiser', 'cabinet shelf'],

  // Tech & Gadgets
  'phone ring holder':    ['pop socket grip', 'magnetic car mount', 'wireless charger pad', 'cable organiser', 'phone stand'],
  'wireless earbuds':     ['bluetooth headphones', 'ear tips silicone', 'earphone case', 'noise cancelling buds', 'sports earbuds'],
  'smartwatch':           ['watch band replacement', 'screen protector watch', 'fitness tracker', 'smart ring', 'health monitor'],

  // Pet
  'cat scratcher':        ['cat tree', 'catnip toys', 'interactive cat toy', 'cat window perch', 'cat carrier bag'],
  'dog harness':          ['dog leash retractable', 'dog collar', 'pet tracker gps', 'dog poop bag', 'dog training clicker'],

  // Kids
  'fidget toy':           ['sensory toys', 'stress ball', 'fidget cube', 'pop it toy', 'magnetic tiles'],
  'baby monitor':         ['baby white noise', 'baby thermometer', 'baby nail file', 'baby food maker', 'play mat baby'],
};

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_EXPANSION_TARGETS   = parseInt(process.env.NICHE_EXPANSION_TARGETS   ?? '5',  10);
const MIN_WINNER_ROAS_EXPAND  = parseFloat(process.env.NICHE_EXPAND_MIN_ROAS   ?? '2.0');

@Injectable()
export class NicheDominationService {
  private readonly logger = new Logger(NicheDominationService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ── Main: build domination plan for a winning product ─────────────────────

  async buildDominationPlan(
    winnerProductId:    string,
    winnerProductTitle: string,
    winnerCategory:     string,
    winnerRoas:         number,
  ): Promise<NicheDominationPlan | null> {

    if (winnerRoas < MIN_WINNER_ROAS_EXPAND) return null;

    const expansionKeywords = this.resolveExpansionKeywords(
      winnerProductTitle, winnerCategory,
    );
    if (!expansionKeywords.length) return null;

    // Filter out keywords we're already testing or running
    const alreadyCovered = await this.getAlreadyCoveredKeywords(winnerCategory);
    const alreadySet     = new Set(alreadyCovered.map(k => k.toLowerCase()));

    const expansionTargets: NicheExpansionTarget[] = expansionKeywords
      .filter(kw => !alreadySet.has(kw.toLowerCase()))
      .slice(0, MAX_EXPANSION_TARGETS)
      .map((kw, i) => ({
        keyword:      kw,
        category:     winnerCategory,
        sourceWinner: winnerProductTitle,
        priority:     i < 2 ? 'HIGH' : 'MEDIUM',
        rationale:    `Adjacent to winner "${winnerProductTitle}" (ROAS ${winnerRoas.toFixed(2)}) in ${winnerCategory} niche`,
      }));

    if (!expansionTargets.length) {
      this.logger.log(
        `[NicheDOM] "${winnerProductTitle}" — all adjacent keywords already covered`,
      );
      return null;
    }

    await this.logDominationPlan(winnerProductId, expansionTargets);

    const plan: NicheDominationPlan = {
      winnerProductId,
      winnerProductTitle,
      winnerCategory,
      winnerRoas,
      expansionTargets,
      alreadyCovered,
      generatedAt: new Date(),
    };

    this.logger.log(
      `[NicheDOM] "${winnerProductTitle}" ROAS=${winnerRoas.toFixed(2)} → ` +
      `${expansionTargets.length} expansion targets: [${expansionTargets.map(t => t.keyword).join(', ')}]`,
    );

    return plan;
  }

  // ── Get top niche domination coverage stats ───────────────────────────────

  async getDominationCoverage(): Promise<Array<{
    category: string; activeProducts: number; totalAdjacent: number; coveragePct: number;
  }>> {
    try {
      const rows = await this.db.execute(sql`
        SELECT
          COALESCE(p.category, 'unknown') AS category,
          COUNT(DISTINCT c.product_id)    AS active_products
        FROM   campaigns c
        JOIN   products   p ON p.id = c.product_id
        WHERE  c.status = 'active'
        GROUP BY p.category
        ORDER BY active_products DESC
        LIMIT 20
      `) as unknown as Array<{ category: string; active_products: number }>;

      return rows.map(r => {
        const totalAdjacent = this.countTotalAdjacent(r.category);
        return {
          category:      r.category,
          activeProducts: r.active_products,
          totalAdjacent,
          coveragePct:   totalAdjacent > 0
            ? Math.round((r.active_products / totalAdjacent) * 100)
            : 0,
        };
      });
    } catch { return []; }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private resolveExpansionKeywords(title: string, category: string): string[] {
    const titleLower = title.toLowerCase();

    // 1. Direct adjacency lookup by product title substring
    for (const [key, adjacents] of Object.entries(NICHE_ADJACENCY)) {
      if (titleLower.includes(key) || key.includes(titleLower.split(' ')[0] ?? '')) {
        return adjacents;
      }
    }

    // 2. Category-based fallback adjacency
    const categoryMap: Record<string, string[]> = {
      health:     ['posture corrector', 'massage gun', 'heating pad', 'compression socks', 'pain relief'],
      beauty:     ['jade roller', 'led face mask', 'hair growth serum', 'face serum', 'eye cream'],
      fitness:    ['resistance band', 'ab roller', 'foam roller', 'jump rope', 'yoga mat'],
      kitchen:    ['portable blender', 'air fryer accessories', 'kitchen organiser', 'food scale', 'spice rack'],
      tech:       ['phone ring holder', 'wireless charger', 'cable organiser', 'laptop stand', 'screen cleaner'],
      pet:        ['dog harness', 'cat scratcher', 'pet tracker', 'dog toy', 'cat carrier'],
      kids:       ['fidget toy', 'sensory toys', 'play mat', 'bath toy', 'educational toy'],
      fashion:    ['compression socks', 'posture shirt', 'phone bag', 'travel pillow', 'packable jacket'],
      home:       ['kitchen organiser', 'bathroom organiser', 'closet organiser', 'wall hooks', 'cord organiser'],
    };

    const catLower = category.toLowerCase();
    for (const [cat, keywords] of Object.entries(categoryMap)) {
      if (catLower.includes(cat)) return keywords;
    }

    return [];
  }

  private async getAlreadyCoveredKeywords(category: string): Promise<string[]> {
    try {
      const rows = await this.db.execute(sql`
        SELECT DISTINCT LOWER(p.title) AS keyword
        FROM   products p
        JOIN   campaigns c ON c.product_id = p.id
        WHERE  LOWER(p.category) = LOWER(${category})
          AND  c.status IN ('active', 'paused')
        LIMIT 50
      `) as unknown as Array<{ keyword: string }>;
      return rows.map(r => r.keyword);
    } catch { return []; }
  }

  private countTotalAdjacent(category: string): number {
    const catLower = category.toLowerCase();
    let count = 0;
    for (const [key, adjacents] of Object.entries(NICHE_ADJACENCY)) {
      if (catLower.includes(key.split(' ')[0] ?? '')) count += adjacents.length;
    }
    return count || 5; // default estimate
  }

  private async logDominationPlan(
    winnerProductId: string,
    targets: NicheExpansionTarget[],
  ): Promise<void> {
    try {
      for (const target of targets) {
        await this.db.execute(sql`
          INSERT INTO niche_domination_log
            (winner_product_id, expansion_keyword, category, priority, created_at)
          VALUES
            (${winnerProductId}, ${target.keyword}, ${target.category},
             ${target.priority}, NOW())
          ON CONFLICT DO NOTHING
        `);
      }
    } catch { /* non-critical */ }
  }
}
