import { Injectable, Logger, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { SystemModeService }              from '../../system-mode/system-mode.service';
import { AlertingService }             from '../../alerting/alerting.service';
import { GlobalPerformanceService } from './performance.service';
import { ReinvestService }          from './reinvest.service';
import { LongtermStrategyService, StrategyMode } from './longterm-strategy.service';
import { EmpireLimitsService }      from './limits.service';
import { CapitalGrowthEngine }      from './capital-growth.service';
import { OpsLoggerService }         from '../ops/logger.service';

export interface EmpireOptimizeResult {
  cycleId:       string;
  capitalBefore: number;
  capitalAfter:  number;
  growthPct:     number;
  storesActive:  number;
  strategyMode:  StrategyMode;
  reinvested:    number;
  reserved:      number;
  skipped:       boolean;
  skipReason?:   string;
  timestamp:     string;
}

@Injectable()
export class EmpireBrainService {
  private readonly logger = new Logger(EmpireBrainService.name);

  constructor(
    @Inject('PG_POOL') private readonly pool:   Pool,
    private readonly mode:        SystemModeService,
    private readonly alert:       AlertingService,
    private readonly performance: GlobalPerformanceService,
    private readonly reinvest:    ReinvestService,
    private readonly strategy:    LongtermStrategyService,
    private readonly limits:      EmpireLimitsService,
    private readonly growth:      CapitalGrowthEngine,
    private readonly opsLogger:   OpsLoggerService,
  ) {}

  async optimizeEmpire(): Promise<EmpireOptimizeResult> {
    const cycleId   = `empire_${Date.now()}`;
    const timestamp = new Date().toISOString();

    if (!(this.mode.isAdsEnabled())) {
      return this.skip(cycleId, 0, 0, 'conservative', timestamp, 'SYSTEM_NOT_SAFE');
    }

    const snap = await this.performance.getSnapshot();

    this.opsLogger.log('Empire cycle start', 'EmpireBrain', {
      capital: snap.totalCapital, growth: snap.growthRate, stores: snap.activeStores,
    });

    const guard = await this.limits.checkCapitalGuard(snap.totalCapital);
    if (guard.halted) {
      await this.alert.sendCritical({ title: 'EmpireBrain Failure', message: `Capital guard: ${guard.reason}`, tenantId: '__system__' });
      await this.mode.setMode('paused' as any, `CAPITAL_GUARD: ${guard.reason}`, 'system');
      return this.skip(cycleId, snap.totalCapital, snap.activeStores, 'conservative', timestamp, guard.reason);
    }

    const strategyMode = await this.strategy.determineMode(snap);
    const allocation   = await this.reinvest.allocate(snap.totalProfit, strategyMode);

    if (await this.limits.canAddStore(snap.activeStores) && strategyMode === 'aggressive' && snap.growthRate > 5) {
      await this.queueStoreExpansion(cycleId);
    }

    const updatedCapital = await this.growth.optimize(snap.totalCapital, allocation);

    await this.performance.recordCycle({
      cycleId, capitalBefore: snap.totalCapital, capitalAfter: updatedCapital,
      reinvested: allocation.reinvested, reserved: allocation.reserved, strategyMode,
    });

    const growthPct = snap.totalCapital > 0
      ? ((updatedCapital - snap.totalCapital) / snap.totalCapital) * 100
      : 0;

    await this.alert.sendInfo({ title: 'Empire Status', message: JSON.stringify({ capital: updatedCapital, growthPct, stores: snap.activeStores }), tenantId: '__system__' });

    this.opsLogger.log('Empire cycle complete', 'EmpireBrain', {
      cycleId, capitalBefore: snap.totalCapital, capitalAfter: updatedCapital,
      growthPct: growthPct.toFixed(2), strategyMode,
    });

    return {
      cycleId, capitalBefore: snap.totalCapital, capitalAfter: updatedCapital,
      growthPct, storesActive: snap.activeStores, strategyMode,
      reinvested: allocation.reinvested, reserved: allocation.reserved,
      skipped: false, timestamp,
    };
  }

  private async queueStoreExpansion(cycleId: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO empire_expansion_queue (cycle_id, requested_at, status) VALUES ($1, NOW(), 'PENDING') ON CONFLICT DO NOTHING`,
        [cycleId],
      );
    } catch (err) {
      this.logger.warn(`Store expansion queue failed: ${(err as Error).message}`);
    }
  }

  private skip(cycleId: string, capital: number, stores: number, mode: StrategyMode, timestamp: string, reason?: string): EmpireOptimizeResult {
    return {
      cycleId, capitalBefore: capital, capitalAfter: capital, growthPct: 0,
      storesActive: stores, strategyMode: mode, reinvested: 0, reserved: 0,
      skipped: true, skipReason: reason, timestamp,
    };
  }
}
