/**
 * GlobalProfitTargetService — V31 Requirement 8
 *
 * Req 8 — GLOBAL PROFIT TARGET:
 *   System objective: MAXIMIZE TOTAL PROFIT, NOT JUST INDIVIDUAL CAMPAIGN SUCCESS.
 *
 *   Tracks system-wide profit vs target. Adjusts global strategy mode based on progress:
 *     - Below GP_AGGRESSIVE_THRESHOLD % of target → AGGRESSIVE mode (push harder)
 *     - Above GP_CONSERVATIVE_THRESHOLD % of target → CONSERVATIVE mode (preserve gains)
 *     - Between thresholds → BALANCED mode
 *
 *   Emits:
 *     - ProfitSnapshot every GP_SNAPSHOT_INTERVAL_MINUTES
 *     - Mode change events when threshold crossed
 *     - Rebalance trigger to GlobalCapitalOptimizer when significantly off-track
 *
 *   Capital rebalance trigger:
 *     If projectedMonthly < monthlyTarget × 0.7 → trigger immediate rebalance
 *     Rebalance moves capital from low-performing stores to high-performing ones.
 *
 *   INR denomination:
 *     All profit and target figures are INR (₹).
 *     USD figures converted via live USD_INR_RATE (env or Redis).
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PROFIT_ENGINE_TOKENS } from './profit-engine.module';
import {
  ProfitSnapshot,
  ProfitTargetConfig,
} from './profit-engine-types';
import { GlobalCapitalOptimizer } from './global-capital-optimizer.service';
import { StrategyEvolverService } from './strategy-evolver.service';

// ── Config ────────────────────────────────────────────────────────────────────
const MONTHLY_TARGET_INR        = parseFloat(process.env.GP_MONTHLY_TARGET_INR        ?? '500000'); // ₹5L
const DAILY_TARGET_INR          = parseFloat(process.env.GP_DAILY_TARGET_INR          ?? '16667');  // ₹5L / 30
const AGGRESSIVE_THRESHOLD_PCT  = parseFloat(process.env.GP_AGGRESSIVE_THRESHOLD_PCT  ?? '0.60');   // < 60% → push harder
const CONSERVATIVE_THRESHOLD_PCT= parseFloat(process.env.GP_CONSERVATIVE_THRESHOLD_PCT ?? '0.90'); // > 90% → preserve
const SNAPSHOT_INTERVAL_MIN     = parseInt  (process.env.GP_SNAPSHOT_INTERVAL_MIN     ?? '15', 10);
const REBALANCE_TRIGGER_PCT     = parseFloat(process.env.GP_REBALANCE_TRIGGER_PCT     ?? '0.70');   // < 70% projection → rebalance
const USD_INR_RATE_KEY          = 'v16:fx:usd-inr-rate';

export type GlobalMode = 'AGGRESSIVE' | 'BALANCED' | 'CONSERVATIVE';

@Injectable()
export class GlobalProfitTargetService implements OnModuleInit {
  private readonly logger = new Logger(GlobalProfitTargetService.name);

  private currentMode: GlobalMode = 'BALANCED';
  private latestSnapshot: ProfitSnapshot | null = null;
  private monthStart = new Date();

  private readonly targetConfig: ProfitTargetConfig = {
    monthlyTargetInr:          MONTHLY_TARGET_INR,
    dailyTargetInr:            DAILY_TARGET_INR,
    aggressiveThresholdPct:    AGGRESSIVE_THRESHOLD_PCT,
    conservativeThresholdPct:  CONSERVATIVE_THRESHOLD_PCT,
  };

  constructor(
    @Inject(PROFIT_ENGINE_TOKENS.PG_POOL)   private readonly pool:     Pool,
    @Inject(PROFIT_ENGINE_TOKENS.REDIS)      private readonly redis:    Redis,
    private readonly capitalOptimizer:       GlobalCapitalOptimizer,
    private readonly strategyEvolver:        StrategyEvolverService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Reset month start tracking
    const now = new Date();
    this.monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    await this.takeSnapshot();
    this.logger.log(
      `[GlobalProfitTarget] online: target=₹${MONTHLY_TARGET_INR.toLocaleString()} ` +
      `mode=${this.currentMode}`,
    );
  }

  // ── Scheduled snapshot ────────────────────────────────────────────────────

  @Cron(`*/${SNAPSHOT_INTERVAL_MIN} * * * *`)
  async scheduledSnapshot(): Promise<void> {
    try {
      const snapshot = await this.takeSnapshot();
      await this.adjustGlobalMode(snapshot);
      await this.checkRebalanceTrigger(snapshot);
    } catch (err: any) {
      this.logger.error(`[GlobalProfitTarget] snapshot failed: ${err.message}`);
    }
  }

  @Cron('0 0 1 * *') // 1st of every month at midnight
  async resetMonthlyTracking(): Promise<void> {
    this.monthStart = new Date();
    this.logger.log('[GlobalProfitTarget] Monthly target cycle reset');
    await this.pool.query(
      `INSERT INTO pe_monthly_targets
         (month_start, target_inr, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (month_start) DO NOTHING`,
      [this.monthStart, MONTHLY_TARGET_INR],
    ).catch(() => {});
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getCurrentMode(): GlobalMode { return this.currentMode; }

  getLatestSnapshot(): ProfitSnapshot | null { return this.latestSnapshot; }

  getTargetConfig(): ProfitTargetConfig { return this.targetConfig; }

  /**
   * Called by V30 kernel before every SCALE decision.
   * Returns whether aggressive capital deployment is warranted.
   */
  shouldAggressivelyScale(): boolean {
    if (!this.latestSnapshot) return false;
    return (
      this.currentMode === 'AGGRESSIVE' ||
      this.latestSnapshot.targetProgressPct < AGGRESSIVE_THRESHOLD_PCT
    );
  }

  /**
   * Called by V30 kernel before every HOLD/REDUCE decision.
   * Returns whether we should preserve gains.
   */
  shouldPreserveGains(): boolean {
    if (!this.latestSnapshot) return false;
    return (
      this.currentMode === 'CONSERVATIVE' &&
      this.latestSnapshot.targetProgressPct >= CONSERVATIVE_THRESHOLD_PCT
    );
  }

  /**
   * Record profit event from a completed execution.
   * Called by V30/V16 kernel after every successful SCALE cycle.
   */
  async recordProfitEvent(
    storeId:    string,
    campaignId: string,
    profitInr:  number,
    spendInr:   number,
    revenueInr: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO pe_profit_events
         (store_id, campaign_id, profit_inr, spend_inr, revenue_inr, recorded_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [storeId, campaignId, profitInr, spendInr, revenueInr],
    ).catch(e => this.logger.warn(`recordProfitEvent failed: ${e.message}`));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async takeSnapshot(): Promise<ProfitSnapshot> {
    const usdInr = await this.fetchUsdInrRate();

    const {
      monthlyProfitInr,
      dailyProfitInr,
      weeklyProfitInr,
      globalRoi,
      activeStores,
      activeCampaigns,
    } = await this.aggregateProfitData(usdInr);

    // Progress calculation
    const daysElapsed   = Math.max(1, (Date.now() - this.monthStart.getTime()) / 86_400_000);
    const daysInMonth   = 30;
    const progressPct   = MONTHLY_TARGET_INR > 0 ? monthlyProfitInr / MONTHLY_TARGET_INR : 0;
    const projectedMonthly = monthlyProfitInr * (daysInMonth / daysElapsed);
    const onTrack       = projectedMonthly >= MONTHLY_TARGET_INR * REBALANCE_TRIGGER_PCT;

    const snapshot: ProfitSnapshot = {
      snapshotAt:        new Date(),
      totalProfitInr:    monthlyProfitInr,
      dailyProfitInr,
      weeklyProfitInr,
      monthlyProfitInr,
      activeStores,
      activeCampaigns,
      globalROI:         globalRoi,
      targetProgressPct: progressPct,
      projectedMonthly,
      on_track:          onTrack,
    };

    this.latestSnapshot = snapshot;
    await this.persistSnapshot(snapshot);

    this.logger.log(
      `[GlobalProfitTarget] snapshot: ` +
      `monthly=₹${monthlyProfitInr.toFixed(0)} ` +
      `target=₹${MONTHLY_TARGET_INR.toFixed(0)} ` +
      `progress=${(progressPct * 100).toFixed(1)}% ` +
      `projected=₹${projectedMonthly.toFixed(0)} ` +
      `mode=${this.currentMode} on_track=${onTrack}`,
    );

    return snapshot;
  }

  private async adjustGlobalMode(snapshot: ProfitSnapshot): Promise<void> {
    let newMode: GlobalMode;

    if (snapshot.targetProgressPct < AGGRESSIVE_THRESHOLD_PCT) {
      newMode = 'AGGRESSIVE';
    } else if (snapshot.targetProgressPct >= CONSERVATIVE_THRESHOLD_PCT) {
      newMode = 'CONSERVATIVE';
    } else {
      newMode = 'BALANCED';
    }

    if (newMode !== this.currentMode) {
      this.logger.warn(
        `[GlobalProfitTarget] MODE CHANGE: ${this.currentMode} → ${newMode} ` +
        `(progress=${(snapshot.targetProgressPct * 100).toFixed(1)}%)`,
      );
      this.currentMode = newMode;
      await this.redis.set('pe:global-mode', newMode, 'EX', 3600).catch(() => {});
      await this.pool.query(
        `INSERT INTO pe_mode_changes (mode, trigger_progress_pct, changed_at)
         VALUES ($1, $2, NOW())`,
        [newMode, snapshot.targetProgressPct],
      ).catch(() => {});
    }
  }

  private async checkRebalanceTrigger(snapshot: ProfitSnapshot): Promise<void> {
    if (!snapshot.on_track && snapshot.projectedMonthly < MONTHLY_TARGET_INR * REBALANCE_TRIGGER_PCT) {
      this.logger.warn(
        `[GlobalProfitTarget] REBALANCE TRIGGER: projected=₹${snapshot.projectedMonthly.toFixed(0)} ` +
        `< ${(REBALANCE_TRIGGER_PCT * 100).toFixed(0)}% of target=₹${MONTHLY_TARGET_INR.toFixed(0)}`,
      );
      // Trigger immediate capital rebalance
      await this.capitalOptimizer.computeOptimalAllocation().catch(
        e => this.logger.warn(`Rebalance trigger failed: ${e.message}`),
      );

      // If significantly off-track, also trigger strategy evolution
      if (snapshot.targetProgressPct < AGGRESSIVE_THRESHOLD_PCT * 0.7) {
        await this.strategyEvolver.runEvolutionCycle().catch(
          e => this.logger.warn(`Evolution trigger failed: ${e.message}`),
        );
      }
    }
  }

  private async aggregateProfitData(usdInr: number): Promise<{
    monthlyProfitInr: number;
    dailyProfitInr:   number;
    weeklyProfitInr:  number;
    globalRoi:        number;
    activeStores:     number;
    activeCampaigns:  number;
  }> {
    try {
      const { rows } = await this.pool.query<any>(`
        SELECT
          COALESCE(SUM(profit_inr) FILTER (WHERE recorded_at >= $1),  0) AS monthly_profit,
          COALESCE(SUM(profit_inr) FILTER (WHERE recorded_at >= NOW() - INTERVAL '1 day'), 0) AS daily_profit,
          COALESCE(SUM(profit_inr) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days'), 0) AS weekly_profit,
          COALESCE(SUM(spend_inr)  FILTER (WHERE recorded_at >= $1),  0) AS monthly_spend,
          COALESCE(SUM(revenue_inr)FILTER (WHERE recorded_at >= $1),  0) AS monthly_revenue,
          COUNT(DISTINCT store_id)    AS active_stores,
          COUNT(DISTINCT campaign_id) AS active_campaigns
        FROM pe_profit_events
        WHERE recorded_at >= $1
      `, [this.monthStart]);

      const row            = rows[0] ?? {};
      const monthlySpend   = Number(row.monthly_spend ?? 0);
      const monthlyRevenue = Number(row.monthly_revenue ?? 0);

      return {
        monthlyProfitInr: Number(row.monthly_profit ?? 0),
        dailyProfitInr:   Number(row.daily_profit ?? 0),
        weeklyProfitInr:  Number(row.weekly_profit ?? 0),
        globalRoi:        monthlySpend > 0 ? (monthlyRevenue - monthlySpend) / monthlySpend : 0,
        activeStores:     Number(row.active_stores ?? 0),
        activeCampaigns:  Number(row.active_campaigns ?? 0),
      };
    } catch (e: any) {
      this.logger.warn(`aggregateProfitData failed: ${e.message}`);
      return { monthlyProfitInr: 0, dailyProfitInr: 0, weeklyProfitInr: 0, globalRoi: 0, activeStores: 0, activeCampaigns: 0 };
    }
  }

  private async fetchUsdInrRate(): Promise<number> {
    try {
      const val = await this.redis.get(USD_INR_RATE_KEY);
      return val ? parseFloat(val) : 83.5;
    } catch {
      return 83.5;
    }
  }

  private async persistSnapshot(snapshot: ProfitSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO pe_profit_snapshots
         (snapshot_at, total_profit_inr, daily_profit_inr, weekly_profit_inr,
          monthly_profit_inr, global_roi, target_progress_pct, projected_monthly,
          on_track, active_stores, active_campaigns, mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        snapshot.snapshotAt,
        snapshot.totalProfitInr,    snapshot.dailyProfitInr,
        snapshot.weeklyProfitInr,   snapshot.monthlyProfitInr,
        snapshot.globalROI,         snapshot.targetProgressPct,
        snapshot.projectedMonthly,  snapshot.on_track,
        snapshot.activeStores,      snapshot.activeCampaigns,
        this.currentMode,
      ],
    ).catch(e => this.logger.warn(`persistSnapshot failed: ${e.message}`));
  }
}
