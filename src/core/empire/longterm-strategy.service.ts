/**
 * LongtermStrategyService — Empire Mode Determination
 *
 * AUTO mode: determines aggressive/conservative from metrics.
 * MANUAL override via setMode().
 *
 * aggressive when:
 *   - growthRate > 10% AND winRate > 60% AND totalCapital > minCapital
 * conservative otherwise (default safe state).
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export type StrategyMode = 'aggressive' | 'conservative';

const REDIS_KEY = 'empire:strategy:mode';
const REDIS_MANUAL_KEY = 'empire:strategy:manual';

@Injectable()
export class LongtermStrategyService {
  private readonly logger = new Logger(LongtermStrategyService.name);

  // Thresholds for AUTO mode
  private readonly GROWTH_THRESHOLD  = 10;  // %
  private readonly WIN_RATE_THRESHOLD = 60; // %
  private readonly MIN_CAPITAL        = 50_000; // ₹

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async determineMode(snap: {
    growthRate:    number;
    winRate:       number;
    totalCapital:  number;
  }): Promise<StrategyMode> {
    // Check manual override
    const manual = await this.redis.get(REDIS_MANUAL_KEY);
    if (manual === 'aggressive' || manual === 'conservative') {
      return manual;
    }

    // AUTO determination
    const isAggressive =
      snap.growthRate   >= this.GROWTH_THRESHOLD  &&
      snap.winRate      >= this.WIN_RATE_THRESHOLD &&
      snap.totalCapital >= this.MIN_CAPITAL;

    const mode: StrategyMode = isAggressive ? 'aggressive' : 'conservative';

    await this.redis.set(REDIS_KEY, mode);
    this.logger.debug(`[Strategy] AUTO mode=${mode} (growth=${snap.growthRate}% winRate=${snap.winRate}%)`);

    return mode;
  }

  async setMode(mode: StrategyMode): Promise<void> {
    await this.redis.set(REDIS_MANUAL_KEY, mode);
    this.logger.warn(`[Strategy] Manual override → ${mode}`);
  }

  async clearManualOverride(): Promise<void> {
    await this.redis.del(REDIS_MANUAL_KEY);
    this.logger.log('[Strategy] Manual override cleared → AUTO mode');
  }

  async getMode(): Promise<StrategyMode> {
    const mode = (await this.redis.get(REDIS_KEY)) as StrategyMode | null;
    return mode ?? 'conservative';
  }
}
