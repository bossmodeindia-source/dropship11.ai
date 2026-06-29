import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MetaPerformanceService } from './meta-performance.service';

/**
 * Runs the Meta Ads performance-tracking + scaling cycle every 6 hours.
 *
 * Cron expression (6-field, seconds included):
 *   '0 0 0,6,12,18 * * *'
 *   │ │ └────────── hours: midnight, 6am, noon, 6pm
 *   │ └──────────── minute: 0
 *   └────────────── second: 0
 *
 * Any unhandled error is caught here so the process never crashes.
 */
@Injectable()
export class MetaPerformanceScheduler {
  private readonly logger = new Logger(MetaPerformanceScheduler.name);

  constructor(
    private readonly performanceService: MetaPerformanceService,
  ) {}

  @Cron('0 0 0,6,12,18 * * *')
  async handlePerformanceCycle(): Promise<void> {
    this.logger.log('⏱  Meta Ads performance cycle triggered (every 6 h)');

    try {
      const result = await this.performanceService.runFullCycle();
      this.logger.log(
        `✅ Cycle complete – processed=${result.processed} errors=${result.errors}`,
      );
    } catch (err) {
      // Safety: scheduler must never crash the NestJS process
      this.logger.error(
        `Scheduler cycle unhandled error: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
