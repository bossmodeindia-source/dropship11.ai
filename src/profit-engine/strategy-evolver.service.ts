/**
 * StrategyEvolverService — V31 Requirement 7
 *
 * Req 7 — STRATEGY EVOLUTION ENGINE (V29 EXTENSION):
 *   Extends V29 StrategyEvolutionService with profit-maximization objectives.
 *
 *   - KEEP BEST:     Top SE_ELITE_KEEP strategies by fitness score are ELITE.
 *   - KILL WEAK:     Strategies below SE_FITNESS_KILL_FLOOR are killed.
 *   - AUTO-GENERATE: Elites spawn mutated children targeting profitable parameter zones.
 *
 * Fitness score:
 *   fitness = (totalProfit × PROFIT_W) + (roi × ROI_W) + (winRate × WIN_RATE_W)
 *   Normalized to [0, 1] within current population.
 *
 * Mutation:
 *   Parameters mutated proportionally to how far ROI is below the elite's ROI.
 *   High-profit parameter zones get higher mutation probability (directed search).
 *
 * Evolution runs on cron: every SE_EVOLUTION_INTERVAL_HOURS hours.
 * Integrates with V29 StrategyEngine for actual parameter enforcement.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PROFIT_ENGINE_TOKENS } from './profit-engine.module';
import {
  StrategyFitnessRecord,
  EvolutionResult,
} from './profit-engine-types';

// ── Config ────────────────────────────────────────────────────────────────────
const ELITE_KEEP               = parseInt  (process.env.SE_ELITE_KEEP              ?? '3',    10);
const FITNESS_KILL_FLOOR       = parseFloat(process.env.SE_FITNESS_KILL_FLOOR      ?? '0.15');
const CHILDREN_PER_ELITE       = parseInt  (process.env.SE_CHILDREN_PER_ELITE      ?? '2',    10);
const MIN_CYCLES_BEFORE_KILL   = parseInt  (process.env.SE_MIN_CYCLES_BEFORE_KILL  ?? '5',    10);
const EVOLUTION_INTERVAL_HOURS = parseInt  (process.env.SE_EVOLUTION_INTERVAL_HOURS ?? '6',   10);

// Fitness weights (must sum to 1.0)
const PROFIT_W   = 0.50;
const ROI_W      = 0.30;
const WIN_RATE_W = 0.20;

// Mutation bounds for strategy parameters
const MUTATION_BOUNDS = {
  scaleFactor:             { min: 1.05, max: 2.50, step: 0.05 },
  maxCapitalDeployPct:     { min: 0.05, max: 0.60, step: 0.05 },
  minRoasThreshold:        { min: 1.10, max: 3.00, step: 0.10 },
  maxDrawdownPct:          { min: 0.05, max: 0.40, step: 0.05 },
  minWinnerConfidence:     { min: 0.40, max: 0.95, step: 0.05 },
  explorationBudgetPct:    { min: 0.05, max: 0.40, step: 0.05 },
  winsRequiredToScale:     { min: 1,    max: 10,   step: 1    },
  maxConsecutiveLosses:    { min: 1,    max: 8,    step: 1    },
  minAttributionConfidence:{ min: 0.40, max: 0.95, step: 0.05 },
  minSupplierReliability:  { min: 0.50, max: 0.99, step: 0.05 },
};

@Injectable()
export class StrategyEvolverService {
  private readonly logger = new Logger(StrategyEvolverService.name);
  private lastEvolutionAt: Date | null = null;
  private totalEvolutions = 0;

  constructor(
    @Inject(PROFIT_ENGINE_TOKENS.PG_POOL) private readonly pool: Pool,
  ) {}

  // ── Scheduled evolution ────────────────────────────────────────────────────

  @Cron(`0 */${EVOLUTION_INTERVAL_HOURS} * * *`)
  async scheduledEvolution(): Promise<void> {
    this.logger.log(`[StrategyEvolver] Scheduled evolution (cycle=${++this.totalEvolutions})`);
    try {
      const result = await this.runEvolutionCycle();
      this.logger.log(
        `[StrategyEvolver] cycle complete: ` +
        `elite=${result.eliteKept.length} killed=${result.weakKilled.length} ` +
        `new=${result.newGenerated.length}`,
      );
    } catch (err: any) {
      this.logger.error(`[StrategyEvolver] evolution failed: ${err.message}`);
    }
  }

  // ── Core evolution cycle ───────────────────────────────────────────────────

  async runEvolutionCycle(): Promise<EvolutionResult> {
    const cycleId = uuidv4();
    this.lastEvolutionAt = new Date();

    // 1. Load fitness records
    const records = await this.loadFitnessRecords();
    if (records.length < 2) {
      this.logger.warn('[StrategyEvolver] Insufficient strategies for evolution (need ≥2)');
      return { eliteKept: [], weakKilled: [], newGenerated: [], cycleId };
    }

    // 2. Normalize fitness scores to [0, 1]
    const normalized = this.normalizeFitness(records);

    // 3. Identify elites and weak strategies
    const sorted    = normalized.sort((a, b) => b.fitness - a.fitness);
    const elites    = sorted.slice(0, ELITE_KEEP);
    const weakCandidates = sorted.filter(
      s => s.fitness < FITNESS_KILL_FLOOR && s.cycles >= MIN_CYCLES_BEFORE_KILL,
    );

    // 4. Kill weak strategies
    const weakKilled: string[] = [];
    for (const w of weakCandidates) {
      await this.killStrategy(w.strategyId, `fitness=${w.fitness.toFixed(3)} < floor=${FITNESS_KILL_FLOOR}`);
      weakKilled.push(w.strategyId);
    }

    // 5. Mark elites
    const eliteKept: string[] = [];
    for (const e of elites) {
      await this.markElite(e.strategyId);
      eliteKept.push(e.strategyId);
    }

    // 6. Generate children from elites
    const newGenerated: string[] = [];
    for (const elite of elites) {
      const eliteParams = await this.loadStrategyParams(elite.strategyId);
      if (!eliteParams) continue;

      for (let i = 0; i < CHILDREN_PER_ELITE; i++) {
        const child = this.mutate(eliteParams, elite.roi, i % 2 === 0 ? 'DIRECTED' : 'RANDOM');
        const childId = await this.insertChild(elite.strategyId, child, elite.fitness);
        if (childId) newGenerated.push(childId);
      }
    }

    // 7. Log evolution cycle
    await this.logCycle(cycleId, eliteKept, weakKilled, newGenerated);

    return { eliteKept, weakKilled, newGenerated, cycleId };
  }

  /**
   * Get fitness leaderboard — used by GlobalProfitTargetService
   * to understand which strategies are driving returns.
   */
  async getFitnessLeaderboard(limit = 10): Promise<StrategyFitnessRecord[]> {
    return (await this.loadFitnessRecords()).slice(0, limit);
  }

  getStatus(): Record<string, unknown> {
    return {
      totalEvolutions:  this.totalEvolutions,
      lastEvolutionAt:  this.lastEvolutionAt?.toISOString() ?? 'never',
      eliteKeep:        ELITE_KEEP,
      fitnessKillFloor: FITNESS_KILL_FLOOR,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async loadFitnessRecords(): Promise<StrategyFitnessRecord[]> {
    try {
      const { rows } = await this.pool.query<any>(`
        SELECT
          s.id            AS strategy_id,
          s.name,
          s.generation,
          s.status,
          COALESCE(p.total_profit, 0) AS total_profit,
          COALESCE(p.avg_roi, 0)      AS roi,
          COALESCE(p.win_rate, 0)     AS win_rate,
          COALESCE(p.total_cycles, 0) AS cycles
        FROM strategies s
        LEFT JOIN (
          SELECT
            strategy_id,
            SUM(profit_delta)          AS total_profit,
            AVG(roi)                   AS avg_roi,
            AVG(CASE WHEN profit_delta > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
            COUNT(*)                   AS total_cycles
          FROM strategy_performance_log
          WHERE created_at > NOW() - INTERVAL '7 days'
          GROUP BY strategy_id
        ) p ON p.strategy_id = s.id
        WHERE s.status NOT IN ('KILLED')
        ORDER BY total_profit DESC
        LIMIT 50
      `);

      return rows.map((r: any) => ({
        strategyId:  r.strategy_id,
        name:        r.name,
        totalProfit: Number(r.total_profit),
        roi:         Number(r.roi),
        winRate:     Number(r.win_rate),
        cycles:      Number(r.cycles),
        fitness:     0, // computed in normalizeFitness
        generation:  Number(r.generation ?? 1),
        status:      r.status as StrategyFitnessRecord['status'],
      }));
    } catch (e: any) {
      this.logger.warn(`loadFitnessRecords failed: ${e.message}`);
      return [];
    }
  }

  private normalizeFitness(records: StrategyFitnessRecord[]): StrategyFitnessRecord[] {
    if (records.length === 0) return [];

    const maxProfit  = Math.max(...records.map(r => r.totalProfit), 0.01);
    const maxROI     = Math.max(...records.map(r => r.roi), 0.01);

    return records.map(r => ({
      ...r,
      fitness:
        PROFIT_W   * Math.max(0, r.totalProfit / maxProfit) +
        ROI_W      * Math.max(0, r.roi / maxROI) +
        WIN_RATE_W * r.winRate,
    }));
  }

  /**
   * Mutate strategy parameters.
   * DIRECTED: perturb parameters that most impact profit (scale toward elite values).
   * RANDOM:   uniform random perturbation within bounds.
   */
  private mutate(
    params:    Record<string, number>,
    eliteROI:  number,
    mode:      'DIRECTED' | 'RANDOM',
  ): Record<string, number> {
    const child = { ...params };

    for (const [key, bounds] of Object.entries(MUTATION_BOUNDS)) {
      const current = child[key] ?? (bounds.min + bounds.max) / 2;
      let delta: number;

      if (mode === 'DIRECTED') {
        // Bias toward profitable direction: if ROI is high, increase scale-related params
        const profitBias = eliteROI > 0.3 ? 1 : -0.5;
        const scaleParams = new Set(['scaleFactor', 'maxCapitalDeployPct', 'winsRequiredToScale']);
        delta = bounds.step * (scaleParams.has(key) ? profitBias : (Math.random() - 0.5)) * 2;
      } else {
        delta = bounds.step * (Math.random() - 0.5) * 4;
      }

      child[key] = Math.max(bounds.min, Math.min(bounds.max, current + delta));
      // Round to step precision
      child[key] = Math.round(child[key] / bounds.step) * bounds.step;
    }

    return child;
  }

  private async loadStrategyParams(strategyId: string): Promise<Record<string, number> | null> {
    try {
      const { rows } = await this.pool.query<any>(
        `SELECT parameters FROM strategies WHERE id = $1`,
        [strategyId],
      );
      return rows[0]?.parameters ?? null;
    } catch { return null; }
  }

  private async insertChild(
    parentId:      string,
    params:        Record<string, number>,
    parentFitness: number,
  ): Promise<string | null> {
    try {
      const childId = uuidv4();
      const { rows } = await this.pool.query<{ generation: number }>(
        `SELECT generation FROM strategies WHERE id = $1`,
        [parentId],
      );
      const generation = (rows[0]?.generation ?? 1) + 1;

      await this.pool.query(
        `INSERT INTO strategies
           (id, name, type, status, parameters, risk_level, description,
            expected_profit, generation, parent_id, created_at, updated_at)
         VALUES ($1, $2, 'EXPERIMENTAL', 'TESTING', $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          childId,
          `evolved-gen${generation}-${childId.slice(0, 6)}`,
          JSON.stringify(params),
          Math.min(1, 0.3 + (params.scaleFactor ?? 1.2) * 0.2),
          `Auto-generated child of ${parentId} (fitness=${parentFitness.toFixed(3)})`,
          0,
          generation,
          parentId,
        ],
      );
      return childId;
    } catch (e: any) {
      this.logger.warn(`insertChild failed: ${e.message}`);
      return null;
    }
  }

  private async killStrategy(strategyId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE strategies SET status = 'KILLED', updated_at = NOW() WHERE id = $1`,
      [strategyId],
    ).catch(e => this.logger.warn(`killStrategy failed: ${e.message}`));
    this.logger.log(`[StrategyEvolver] KILLED strategy=${strategyId} reason=${reason}`);
  }

  private async markElite(strategyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE strategies SET status = 'PROMOTED', updated_at = NOW() WHERE id = $1 AND status NOT IN ('KILLED')`,
      [strategyId],
    ).catch(() => {});
  }

  private async logCycle(
    cycleId:      string,
    eliteKept:    string[],
    weakKilled:   string[],
    newGenerated: string[],
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO pe_evolution_cycles
         (cycle_id, elite_kept, weak_killed, new_generated, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [cycleId, eliteKept, weakKilled, newGenerated],
    ).catch(e => this.logger.warn(`logCycle failed: ${e.message}`));
  }
}
