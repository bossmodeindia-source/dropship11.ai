/**
 * FinanceSnapshotScheduler
 *
 * Nightly cron job that writes daily P&L snapshots for all active tenants.
 * Runs at 00:05 IST (18:35 UTC) every night.
 *
 * Fail-safe: If a single tenant snapshot fails, logs the error and continues
 * to the next tenant — one bad row never blocks the entire batch.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { POOL_TOKEN } from '../common/database/database.module';
import { FinanceTrackingService } from './finance-tracking.service';
import { AlertingService } from '../alerting/alerting.service';

@Injectable()
export class FinanceSnapshotScheduler {
  private readonly logger = new Logger(FinanceSnapshotScheduler.name);

  constructor(
    @Inject(POOL_TOKEN) private readonly pool: Pool,
    private readonly financeTracking: FinanceTrackingService,
    private readonly alerting: AlertingService,
  ) {}

  /**
   * Every night at 00:05 IST — write finance snapshots for all active tenants.
   * '5 18 * * *' = 18:35 UTC = 00:05 IST
   */
  @Cron('5 18 * * *', { name: 'finance-snapshot', timeZone: 'Asia/Kolkata' })
  async runDailySnapshots(): Promise<void> {
    this.logger.log('Finance snapshot job started');

    // Get all distinct active tenant IDs from orders table
    const client = await this.pool.connect();
    let tenantIds: string[] = [];
    try {
      const res = await client.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id
           FROM orders
          WHERE created_at > NOW() - INTERVAL '90 days'
         UNION
         SELECT DISTINCT tenant_id
           FROM user_subscriptions
          WHERE status = 'active'`,
      );
      tenantIds = res.rows.map(r => r.tenant_id);
    } finally {
      client.release();
    }

    this.logger.log(`Running finance snapshots for ${tenantIds.length} tenants`);

    let successCount = 0;
    let failCount    = 0;

    for (const tenantId of tenantIds) {
      try {
        await this.financeTracking.writeSnapshot(tenantId);
        successCount++;
      } catch (err) {
        failCount++;
        this.logger.error(`Snapshot failed for tenant ${tenantId}: ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `Finance snapshot complete: ${successCount} succeeded, ${failCount} failed`,
    );

    if (failCount > 0) {
      await this.alerting.sendCritical({
        title:   '⚠️ Finance Snapshot Failures',
        message: `Daily finance snapshot: ${failCount}/${tenantIds.length} tenants failed. Check logs.`,
      });
    }
  }
}
