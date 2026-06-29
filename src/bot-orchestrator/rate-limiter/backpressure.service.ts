/**
 * BackpressureService
 *
 * Monitors queue depths in real time and applies backpressure when the system
 * approaches overload. Two thresholds:
 *
 *   WARNING_MARK  → log alert + slow down scheduler frequency
 *   BACKPRESSURE  → reject new enqueues until queues drain
 *
 * State is stored in Redis so multiple orchestrator instances share a
 * consistent view without any distributed locking needed.
 *
 * Redis keys:
 *   bp:state     → 'normal' | 'warning' | 'overloaded'  (string, 10s TTL)
 *   bp:rejected  → integer counter of rejected enqueues
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { BotQueueConfig } from '../queues/bot-queue.config';
import {
  QUEUE_SIZE_BACKPRESSURE,
  QUEUE_SIZE_WARNING_MARK,
} from '../queues/bot-queue.constants';

export type BackpressureState = 'normal' | 'warning' | 'overloaded';

@Injectable()
export class BackpressureService {
  private readonly logger = new Logger(BackpressureService.name);
  private readonly STATE_KEY     = 'bp:state';
  private readonly REJECTED_KEY  = 'bp:rejected';
  private readonly STATE_TTL_S   = 10;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly queueConfig: BotQueueConfig,
  ) {}

  /**
   * Evaluate current queue depth and update backpressure state.
   * Called by the scheduler before every enqueue wave.
   * Returns true if new jobs are allowed; false if system is overloaded.
   */
  async evaluate(): Promise<{ state: BackpressureState; totalWaiting: number; allowed: boolean }> {
    const metrics = await this.queueConfig.getQueueMetrics();
    const { totalWaiting, totalActive } = metrics;
    const totalLoad = totalWaiting + totalActive;

    let state: BackpressureState;

    if (totalLoad >= QUEUE_SIZE_BACKPRESSURE) {
      state = 'overloaded';
    } else if (totalLoad >= QUEUE_SIZE_WARNING_MARK) {
      state = 'warning';
    } else {
      state = 'normal';
    }

    // Persist state for other orchestrator instances (TTL ensures stale state expires)
    await this.redis.setex(this.STATE_KEY, this.STATE_TTL_S, state);

    if (state === 'overloaded') {
      await this.redis.incr(this.REJECTED_KEY);
      this.logger.warn(
        `[Backpressure] OVERLOADED — totalLoad=${totalLoad} ` +
        `(waiting=${totalWaiting} active=${totalActive}) ` +
        `threshold=${QUEUE_SIZE_BACKPRESSURE}. Enqueue rejected.`,
      );
    } else if (state === 'warning') {
      this.logger.warn(
        `[Backpressure] WARNING — totalLoad=${totalLoad}/${QUEUE_SIZE_WARNING_MARK}. ` +
        `Scheduler will throttle.`,
      );
    }

    return { state, totalWaiting, allowed: state !== 'overloaded' };
  }

  /** Read the current backpressure state from Redis (fast path for schedulers). */
  async getCurrentState(): Promise<BackpressureState> {
    const raw = await this.redis.get(this.STATE_KEY);
    return (raw as BackpressureState) ?? 'normal';
  }

  /** Return aggregate metrics for health endpoints and dashboards. */
  async getMetrics() {
    const [state, queueMetrics, rejected] = await Promise.all([
      this.getCurrentState(),
      this.queueConfig.getQueueMetrics(),
      this.redis.get(this.REJECTED_KEY),
    ]);

    return {
      state,
      queues:           queueMetrics,
      totalRejected:    parseInt(rejected ?? '0', 10),
      warningThreshold: QUEUE_SIZE_WARNING_MARK,
      hardThreshold:    QUEUE_SIZE_BACKPRESSURE,
    };
  }

  /** Reset rejected counter — call after ops intervention. */
  async resetRejectedCounter(): Promise<void> {
    await this.redis.del(this.REJECTED_KEY);
  }
}
