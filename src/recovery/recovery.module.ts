/**
 * RecoveryModule — V65 UPDATED
 *
 * V65 additions:
 *   + OutboxModule: DisasterRecoveryService now uses OutboxService to re-emit
 *     SUPPLIER_TASK_CREATED and PROFIT_DISTRIBUTED events for orphaned/uncredited
 *     escrows, ensuring idempotent re-delivery via the outbox worker.
 *
 * V60 DisasterRecoveryService (retained):
 *   - OnModuleInit: full reconciliation scan
 *   - Scheduled: every 5 minutes safety net
 *   - V65 ADDS: recoverStuckEscrows(), recoverOrphanedFulfillmentTasks(),
 *     recoverDeliveredWithoutWallet() (see disaster-recovery.additions.ts)
 *
 * V59 RecoveryService (retained):
 *   - Worker crash detection + auto-restart signaling
 *   - Stale job detection (active jobs with no heartbeat > 5 min)
 *   - Dead letter queue (DLQ) processing + replay
 *   - Campaign + order state recovery
 */
import { Module }                   from '@nestjs/common';
import { BullModule }               from '@nestjs/bullmq';
import { RecoveryService }          from './recovery.service';
import { DisasterRecoveryService }  from './disaster-recovery.service';
import { QueueModule }              from '../queue/queue.module';
import { AlertingModule }           from '../alerting/alerting.module';
import { DatabaseModule }           from '../common/database/database.module';
import { RedisModule }              from '../common/redis/redis.module';
import { OutboxModule }             from '../common/outbox/outbox.module';
import { CanonicalQueue }           from '../queue/canonical-queues';
import { DistributedLockService }   from '../common/redis/distributed-lock.service';

@Module({
  imports: [
    QueueModule,
    AlertingModule,
    DatabaseModule,
    RedisModule,
    OutboxModule,  // V65: for escrow recovery re-emission
    BullModule.registerQueue(
      { name: CanonicalQueue.ORDER_PROCESSING    },
      { name: CanonicalQueue.SUPPLIER_FULFILLMENT },
      { name: CanonicalQueue.CAMPAIGN_LAUNCH     },
    ),
  ],
  providers: [
    RecoveryService,          // V59: stale job + DLQ replay
    DisasterRecoveryService,  // V60 + V65: full system reconciliation + escrow recovery
    DistributedLockService,
  ],
  exports: [
    RecoveryService,
    DisasterRecoveryService,
  ],
})
export class RecoveryModule {}
