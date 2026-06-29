/**
 * LossCutterEngine — V31 Requirement 5
 *
 * Req 5 — LOSS CUTTING ENGINE:
 *   Kill faster when:
 *     - Negative ROI trend (3+ declining cycles)
 *     - Poor CTR below CTR_KILL_THRESHOLD
 *     - Poor conversion below CVR_KILL_THRESHOLD
 *     - Loss streak exceeds LOSS_STREAK_KILL
 *     - Drawdown breaches DRAWDOWN_KILL_PCT
 *
 * Signal scoring:
 *   Each trigger adds to a confidence score (0–1).
 *   IMMEDIATE kill if score >= IMMEDIATE_KILL_SCORE.
 *   NEXT_CYCLE  kill if score >= NEXT_CYCLE_SCORE.
 *   WATCH       if any negative signal present.
 *
 * Loss cutter runs:
 *   1. On every V30 kernel cycle (called before SCALE gate)
 *   2. Cron every 10 minutes (background sweep across all campaigns)
 *   3. Directly by V30 kernel on any KILL decision (confirms urgency)
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PROFIT_ENGINE_TOKENS } from './profit-engine.module';
import { LossCutSignal } from './profit-engine-types';

// ── Config ────────────────────────────────────────────────────────────────────
const CTR_KILL_THRESHOLD      = parseFloat(process.env.LC_CTR_KILL_THRESHOLD      ?? '0.005');  // 0.5%
const CVR_KILL_THRESHOLD      = parseFloat(process.env.LC_CVR_KILL_THRESHOLD      ?? '0.01');   // 1%
const ROI_NEGATIVE_THRESHOLD  = parseFloat(process.env.LC_ROI_NEGATIVE_THRESHOLD  ?? '-0.05');  // -5%
const LOSS_STREAK_KILL        = parseInt  (process.env.LC_LOSS_STREAK_KILL        ?? '3',       10);
const DRAWDOWN_KILL_PCT       = parseFloat(process.env.LC_DRAWDOWN_KILL_PCT       ?? '0.35');   // 35%
const TREND_WINDOW            = parseInt  (process.env.LC_TREND_WINDOW            ?? '3',       10);
const IMMEDIATE_KILL_SCORE    = parseFloat(process.env.LC_IMMEDIATE_KILL_SCORE    ?? '0.70');
const NEXT_CYCLE_SCORE        = parseFloat(process.env.LC_NEXT_CYCLE_SCORE        ?? '0.40');

// Signal weights (must sum to 1.0)
const SIGNAL_WEIGHTS = {
  negativeROI:      0.25,
  poorCTR:          0.15,
  poorConversion:   0.20,
  negativeTrend:    0.20,
  lossStreak:       0.10,
  drawdownBreached: 0.10,
};

@Injectable()
export class LossCutterEngine {
  private readonly logger = new Logger(LossCutterEngine.name);

  /** Cache of recent kill signals to avoid redundant log writes */
  private readonly signalCache = new Map<string, { signal: LossCutSignal; cachedAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    @Inject(PROFIT_ENGINE_TOKENS.PG_POOL) private readonly pool: Pool,
  ) {}

  // ── Background sweep ──────────────────────────────────────────────────────

  @Cron('*/10 * * * *')
  async sweepAllCampaigns(): Promise<void> {
    try {
      const campaigns = await this.fetchActiveCampaigns();
      const immediateKills: string[] = [];

      for (const c of campaigns) {
        const signal = await this.evaluate(c);
        if (signal.urgency === 'IMMEDIATE') {
          immediateKills.push(c.campaignId);
          await this.persistKillSignal(signal);
        }
      }

      if (immediateKills.length > 0) {
        this.logger.error(
          `[LossCutter] IMMEDIATE KILL signals for: ${immediateKills.join(', ')}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`[LossCutter] sweep failed: ${err.message}`);
    }
  }

  // ── Core evaluation ───────────────────────────────────────────────────────

  /**
   * Evaluate a campaign for loss cutting.
   * Called inline by V30 kernel before every SCALE decision.
   */
  async evaluate(input: {
    campaignId:       string;
    roi:              number;
    ctr:              number;
    conversionRate:   number;
    consecutiveLosses: number;
    drawdownPct:      number;
    trend:            'RISING' | 'FLAT' | 'DECLINING' | 'VOLATILE';
  }): Promise<LossCutSignal> {
    // Check cache first
    const cached = this.signalCache.get(input.campaignId);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.signal;
    }

    const signals = {
      negativeROI:      input.roi < ROI_NEGATIVE_THRESHOLD,
      poorCTR:          input.ctr > 0 && input.ctr < CTR_KILL_THRESHOLD,
      poorConversion:   input.conversionRate > 0 && input.conversionRate < CVR_KILL_THRESHOLD,
      negativeTrend:    input.trend === 'DECLINING',
      lossStreak:       input.consecutiveLosses >= LOSS_STREAK_KILL,
      drawdownBreached: input.drawdownPct > DRAWDOWN_KILL_PCT,
    };

    // Compute weighted confidence score
    const confidenceScore = Object.entries(signals)
      .filter(([, active]) => active)
      .reduce(
        (score, [key]) => score + (SIGNAL_WEIGHTS[key as keyof typeof SIGNAL_WEIGHTS] ?? 0),
        0,
      );

    const shouldKill = confidenceScore >= NEXT_CYCLE_SCORE;
    const urgency = confidenceScore >= IMMEDIATE_KILL_SCORE
      ? 'IMMEDIATE'
      : confidenceScore >= NEXT_CYCLE_SCORE
        ? 'NEXT_CYCLE'
        : Object.values(signals).some(Boolean)
          ? 'WATCH'
          : 'WATCH';

    const activeSignals = Object.entries(signals)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');

    const reason = shouldKill
      ? `Kill score=${confidenceScore.toFixed(2)} signals=[${activeSignals}]`
      : confidenceScore > 0
        ? `Watch score=${confidenceScore.toFixed(2)} signals=[${activeSignals}]`
        : 'No kill signals';

    const signal: LossCutSignal = {
      campaignId:     input.campaignId,
      shouldKill,
      urgency,
      reason,
      signals,
      confidenceScore,
    };

    this.signalCache.set(input.campaignId, { signal, cachedAt: Date.now() });

    if (shouldKill) {
      this.logger.warn(
        `[LossCutter] ${urgency} kill signal: campaign=${input.campaignId} ` +
        `score=${confidenceScore.toFixed(2)} ` +
        `roi=${(input.roi * 100).toFixed(1)}% ` +
        `ctr=${(input.ctr * 100).toFixed(2)}% ` +
        `cvr=${(input.conversionRate * 100).toFixed(2)}%`,
      );
    }

    return signal;
  }

  /**
   * Hard check: is this campaign an immediate kill candidate?
   * Used by V30 kernel to override SCALE decisions before they reach V29.
   */
  async isImmediateKill(
    campaignId:        string,
    roi:               number,
    consecutiveLosses: number,
    drawdownPct:       number,
  ): Promise<boolean> {
    // Fast path: lossStreak alone is enough
    if (consecutiveLosses >= LOSS_STREAK_KILL + 1) return true;
    // Drawdown alone
    if (drawdownPct > DRAWDOWN_KILL_PCT + 0.10) return true;
    // Both negative ROI + loss streak
    if (roi < ROI_NEGATIVE_THRESHOLD && consecutiveLosses >= LOSS_STREAK_KILL) return true;
    return false;
  }

  /**
   * Fetch historical trend for a campaign using recent profit_tracking rows.
   */
  async computeTrend(campaignId: string): Promise<'RISING' | 'FLAT' | 'DECLINING' | 'VOLATILE'> {
    try {
      const { rows } = await this.pool.query<{ profit: number }>(
        `SELECT profit FROM profit_tracking
         WHERE campaign_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [campaignId, TREND_WINDOW + 2],
      );
      if (rows.length < 3) return 'FLAT';

      const profits = rows.map(r => Number(r.profit));
      const diffs = profits.slice(0, -1).map((p, i) => p - profits[i + 1]);
      const negCount = diffs.filter(d => d < 0).length;
      const posCount = diffs.filter(d => d > 0).length;

      if (negCount === diffs.length) return 'DECLINING';
      if (posCount === diffs.length) return 'RISING';
      if (negCount > diffs.length * 0.7) return 'DECLINING';
      if (posCount > diffs.length * 0.7) return 'RISING';
      return 'VOLATILE';
    } catch {
      return 'FLAT';
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async fetchActiveCampaigns(): Promise<Array<{
    campaignId:        string;
    roi:               number;
    ctr:               number;
    conversionRate:    number;
    consecutiveLosses: number;
    drawdownPct:       number;
    trend:             'RISING' | 'FLAT' | 'DECLINING' | 'VOLATILE';
  }>> {
    try {
      const { rows } = await this.pool.query<any>(`
        SELECT
          ps.campaign_id,
          ps.roas - 1         AS roi,
          COALESCE(ma.ctr, 0) AS ctr,
          COALESCE(ma.conversion_rate, 0) AS conversion_rate,
          ps.consecutive_losses,
          COALESCE(ps.drawdown_pct, 0) AS drawdown_pct
        FROM portfolio_state ps
        LEFT JOIN meta_ad_performance ma ON ma.campaign_id = ps.campaign_id
          AND ma.date = CURRENT_DATE
        WHERE ps.allocated_capital > 0
        ORDER BY ps.consecutive_losses DESC, roi ASC
        LIMIT 100
      `);

      return await Promise.all(rows.map(async (r: any) => ({
        campaignId:        r.campaign_id,
        roi:               Number(r.roi ?? 0),
        ctr:               Number(r.ctr ?? 0),
        conversionRate:    Number(r.conversion_rate ?? 0),
        consecutiveLosses: Number(r.consecutive_losses ?? 0),
        drawdownPct:       Number(r.drawdown_pct ?? 0),
        trend:             await this.computeTrend(r.campaign_id),
      })));
    } catch (e: any) {
      this.logger.warn(`[LossCutter] fetchActiveCampaigns failed: ${e.message}`);
      return [];
    }
  }

  private async persistKillSignal(signal: LossCutSignal): Promise<void> {
    await this.pool.query(
      `INSERT INTO pe_loss_cut_signals
         (campaign_id, confidence_score, urgency, reason, signals_json, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (campaign_id) DO UPDATE SET
         confidence_score = EXCLUDED.confidence_score,
         urgency = EXCLUDED.urgency,
         reason = EXCLUDED.reason,
         signals_json = EXCLUDED.signals_json,
         created_at = NOW()`,
      [
        signal.campaignId,
        signal.confidenceScore,
        signal.urgency,
        signal.reason,
        JSON.stringify(signal.signals),
      ],
    ).catch(e => this.logger.warn(`Kill signal persist failed: ${e.message}`));
  }
}
