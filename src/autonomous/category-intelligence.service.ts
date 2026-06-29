/**
 * CategoryIntelligenceService — V3 MODULE #7
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 *   Track which niches and categories are performing best in real time,
 *   factoring in:
 *     • Historical ROAS / CTR per category (from winner DNA)
 *     • Recent campaign performance per niche
 *     • Seasonal trends (month-based boost factors)
 *     • Platform performance (Meta vs organic)
 *
 * OUTPUT (every cycle)
 *   → Daily ranked list: "top niches to target"
 *   → Niche performance score 0–100
 *   → Seasonal boost tags
 *
 * INTEGRATION
 *   NicheDiscoveryService reads this to re-rank discovered niches.
 *   AutonomousLoopService logs the daily intelligence report.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NicheIntelligence {
  niche:          string;
  category:       string;
  performanceScore: number;    // 0–100
  avgRoas:        number;
  avgCtr:         number;
  totalCampaigns: number;
  winRate:        number;      // % of campaigns that reached SCALE
  seasonalBoost:  number;      // multiplier 0.5–2.0
  trending:       boolean;
  recommendation: 'PRIORITISE' | 'MONITOR' | 'AVOID';
}

export interface DailyIntelligenceReport {
  generatedAt:  Date;
  topNiches:    NicheIntelligence[];
  avoidNiches:  NicheIntelligence[];
  seasonalAlert: string | null;
}

// ── Seasonal calendars (India-focused) ───────────────────────────────────────

const SEASONAL_BOOSTS: Record<number, Record<string, number>> = {
  1:  { 'fitness': 1.8, 'health': 1.6, 'wellness': 1.5 },           // Jan — New Year resolutions
  2:  { 'beauty': 1.5, 'jewellery': 1.4, 'gifts': 1.6 },            // Feb — Valentine's
  3:  { 'fashion': 1.4, 'home': 1.3 },                               // Mar — Holi / spring
  4:  { 'summer': 1.6, 'cooling': 1.5, 'travel': 1.4 },             // Apr — Summer starts
  5:  { 'summer': 1.8, 'cooling': 1.7, 'fitness': 1.3 },            // May — Peak summer
  6:  { 'monsoon': 1.5, 'home': 1.3 },                               // Jun — Monsoon prep
  7:  { 'monsoon': 1.4, 'electronics': 1.2 },                        // Jul
  8:  { 'electronics': 1.3, 'gadgets': 1.3, 'fashion': 1.2 },       // Aug — Independence Day sale
  9:  { 'fashion': 1.4, 'beauty': 1.3, 'home': 1.3 },               // Sep — Navratri / Onam
  10: { 'fashion': 2.0, 'beauty': 1.8, 'home': 1.9, 'electronics': 1.7, 'gifts': 2.0 }, // Oct — Diwali!
  11: { 'fashion': 1.6, 'electronics': 1.8, 'gifts': 1.7 },         // Nov — Post-Diwali / Black Friday
  12: { 'gifts': 1.8, 'toys': 1.7, 'electronics': 1.6 },            // Dec — Christmas / year-end
};

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class CategoryIntelligenceService {
  private readonly logger = new Logger(CategoryIntelligenceService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ── Main: generate daily intelligence report ──────────────────────────────

  async generateDailyReport(): Promise<DailyIntelligenceReport> {
    const month = new Date().getMonth() + 1; // 1-12
    const seasonalMap = SEASONAL_BOOSTS[month] ?? {};

    const nicheStats = await this.fetchNicheStats();
    const intelligence: NicheIntelligence[] = nicheStats.map(row => {
      const cat = row.category.toLowerCase();
      const seasonalBoost = this.getSeasonalBoost(cat, seasonalMap);
      const performanceScore = this.computeScore(row, seasonalBoost);

      return {
        niche:            row.niche,
        category:         row.category,
        performanceScore,
        avgRoas:          row.avg_roas,
        avgCtr:           row.avg_ctr,
        totalCampaigns:   row.total_campaigns,
        winRate:          row.win_rate,
        seasonalBoost,
        trending:         row.avg_roas > 2.0 || seasonalBoost >= 1.5,
        recommendation:   performanceScore >= 65 ? 'PRIORITISE'
                        : performanceScore >= 40 ? 'MONITOR'
                        :                         'AVOID',
      };
    });

    intelligence.sort((a, b) => b.performanceScore - a.performanceScore);

    // Persist to DB for NicheDiscoveryService to read
    await this.persistReport(intelligence);

    const seasonalAlert = this.buildSeasonalAlert(month, seasonalMap);

    const report: DailyIntelligenceReport = {
      generatedAt: new Date(),
      topNiches:   intelligence.filter(n => n.recommendation !== 'AVOID').slice(0, 10),
      avoidNiches: intelligence.filter(n => n.recommendation === 'AVOID').slice(0, 5),
      seasonalAlert,
    };

    this.logger.log(
      `[CategoryIntel] Daily report | top="${report.topNiches[0]?.niche ?? 'none'}" ` +
      `avoid=[${report.avoidNiches.map(n => n.niche).join(', ')}] ` +
      `seasonal="${seasonalAlert ?? 'none'}"`,
    );

    return report;
  }

  // ── Get current season boosts (used by NicheDiscoveryService) ────────────

  getSeasonalMultiplier(category: string): number {
    const month = new Date().getMonth() + 1;
    const map   = SEASONAL_BOOSTS[month] ?? {};
    return this.getSeasonalBoost(category.toLowerCase(), map);
  }

  // ── Fetch performance stats per niche from DB ─────────────────────────────

  private async fetchNicheStats(): Promise<NicheStatRow[]> {
    try {
      const result = await this.db.execute(sql`
        WITH campaign_stats AS (
          SELECT
            p.tags[1]                                                     AS niche,
            p.category,
            COUNT(DISTINCT c.id)                                          AS total_campaigns,
            AVG(COALESCE(c.spend, 0))                                     AS avg_spend,
            AVG(
              CASE WHEN c.performance_status = 'profitable' THEN 1 ELSE 0 END
            )                                                             AS win_rate
          FROM campaigns c
          JOIN products  p ON p.id = c.product_id
          WHERE c.created_at >= NOW() - INTERVAL '30 days'
          GROUP BY p.tags[1], p.category
        ),
        dna_stats AS (
          SELECT
            category,
            avg_roas,
            avg_ctr
          FROM ai_winner_dna
          WHERE sample_size >= 1
        )
        SELECT
          cs.niche,
          cs.category,
          cs.total_campaigns,
          cs.win_rate,
          COALESCE(ds.avg_roas, 1.0) AS avg_roas,
          COALESCE(ds.avg_ctr, 1.0)  AS avg_ctr
        FROM campaign_stats cs
        LEFT JOIN dna_stats  ds ON ds.category = cs.category
        ORDER BY ds.avg_roas DESC NULLS LAST
        LIMIT 50
      `);
      return result as unknown as NicheStatRow[];
    } catch (err) {
      this.logger.warn(`[CategoryIntel] fetchNicheStats failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  private computeScore(row: NicheStatRow, seasonalBoost: number): number {
    const roasScore    = Math.min((row.avg_roas / 3) * 40, 40);    // max 40 pts at ROAS ≥ 3
    const ctrScore     = Math.min((row.avg_ctr / 3) * 25, 25);     // max 25 pts at CTR ≥ 3%
    const winScore     = row.win_rate * 20;                          // max 20 pts at 100% win rate
    const volumeScore  = Math.min(row.total_campaigns / 10, 1) * 10; // max 10 pts at 10+ campaigns
    const seasonScore  = (seasonalBoost - 1) * 10;                  // 0–10 bonus for seasonal

    return Math.min(Math.round(roasScore + ctrScore + winScore + volumeScore + seasonScore), 100);
  }

  private getSeasonalBoost(category: string, map: Record<string, number>): number {
    for (const [key, boost] of Object.entries(map)) {
      if (category.includes(key) || key.includes(category)) return boost;
    }
    return 1.0;
  }

  private buildSeasonalAlert(month: number, map: Record<string, number>): string | null {
    const hot = Object.entries(map)
      .filter(([, boost]) => boost >= 1.5)
      .map(([cat]) => cat);
    if (hot.length === 0) return null;
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `🔥 ${MONTH_NAMES[month - 1]} seasonal surge: ${hot.join(', ')} — prioritise these niches`;
  }

  // ── Persist report for history / external dashboards ─────────────────────

  private async persistReport(niches: NicheIntelligence[]): Promise<void> {
    try {
      const topJson = JSON.stringify(
        niches.slice(0, 20).map(n => ({
          niche: n.niche,
          category: n.category,
          score: n.performanceScore,
          recommendation: n.recommendation,
          seasonalBoost: n.seasonalBoost,
        })),
      );
      await this.db.execute(sql`
        INSERT INTO category_intelligence_log (report_json, generated_at)
        VALUES (${topJson}, NOW())
      `);
    } catch { /* non-critical */ }
  }
}

// ── Internal types ────────────────────────────────────────────────────────────

interface NicheStatRow {
  niche:            string;
  category:         string;
  total_campaigns:  number;
  win_rate:         number;
  avg_roas:         number;
  avg_ctr:          number;
}
