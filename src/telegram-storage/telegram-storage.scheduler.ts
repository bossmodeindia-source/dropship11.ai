/**
 * TelegramStorageScheduler — cron jobs for the Telegram storage infrastructure.
 *
 * All jobs are enqueued into BullMQ rather than running in-process.
 * This ensures:
 *   - Jobs survive process restarts.
 *   - Only one instance runs per job (no duplicate execution on multi-instance deployments).
 *   - Jobs can be monitored in Bull Dashboard.
 *
 * Schedule:
 *   Bot health check:   every 5 minutes
 *   Expired asset purge: every hour at :00
 *   Cold asset archival: every 6 hours at :30
 *   Broken ref repair:  daily at 03:00 UTC
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue }                      from '@nestjs/bullmq';
import { Cron, CronExpression }             from '@nestjs/schedule';
import { Queue }                            from 'bullmq';
import { CanonicalQueue }                   from '../queue/canonical-queues';

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(CanonicalQueue.TG_HEALTH_MONITOR) private readonly healthQueue: Queue,
    @InjectQueue(CanonicalQueue.TG_RETENTION)      private readonly retentionQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Register repeatable jobs (idempotent — Bull deduplicates by jobId)
    await this.healthQueue.add(
      'check',
      {},
      { repeat: { pattern: '*/5 * * * *' }, jobId: 'tg-health-repeat', removeOnComplete: true }
    );
    await this.retentionQueue.add(
      'purge-expired',
      {},
      { repeat: { pattern: '0 * * * *' }, jobId: 'tg-purge-repeat', removeOnComplete: true }
    );
    await this.retentionQueue.add(
      'archive-cold',
      {},
      { repeat: { pattern: '30 */6 * * *' }, jobId: 'tg-archive-repeat', removeOnComplete: true }
    );
    await this.retentionQueue.add(
      'repair-broken',
      {},
      { repeat: { pattern: '0 3 * * *' }, jobId: 'tg-repair-repeat', removeOnComplete: true }
    );

    this.logger.log('Telegram storage scheduled jobs registered');
  }
}
