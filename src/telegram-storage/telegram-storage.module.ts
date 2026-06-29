/**
 * TelegramStorageModule — wires all Telegram storage services, workers,
 * controllers, and queues into a single importable NestJS module.
 *
 * Import in AppModule:
 *   imports: [..., TelegramStorageModule]
 *
 * Queues registered:
 *   telegram:upload         — main upload queue (concurrency 5)
 *   telegram:replication    — async R2/S3 archival
 *   telegram:health-monitor — periodic bot health checks
 *   telegram:retention      — expiry / cold archival
 *
 * Scheduled jobs (via @nestjs/schedule):
 *   Health check:  every 5 minutes
 *   Retention:     every hour
 *   Archival:      every 6 hours
 *
 * Prerequisites (registered globally in AppModule):
 *   DatabaseModule, RedisModule, EncryptionModule,
 *   AuditModule, AlertingModule, StorageModule, RealtimeModule
 */

import { Module }                from '@nestjs/common';
import { BullModule }            from '@nestjs/bullmq';
import { ScheduleModule }        from '@nestjs/schedule';
import { MulterModule }          from '@nestjs/platform-express';
import { SchedulerService }      from './telegram-storage.scheduler';
import { RealtimeModule }        from '../realtime/realtime.module';

// ── Bot Pool ──────────────────────────────────────────────────────────────────
import { TelegramBotPoolModule } from '../telegram-bot-pool/telegram-bot-pool.module';

// ── Core Services ─────────────────────────────────────────────────────────────
import { TelegramAssetRepository }       from './telegram-asset.repository';
import { TelegramDeduplicationService }  from './telegram-deduplication.service';
import { TelegramUploadService }         from './telegram-upload.service';
import { TelegramDownloadService, TelegramCDNService } from './telegram-download.service';
import { TelegramRetentionService }      from './telegram-retention.service';
import { TelegramStorageFacade }   from './telegram-storage-facade.service';

// ── Workers ───────────────────────────────────────────────────────────────────
import { TelegramUploadProcessor }       from './workers/telegram-upload.processor';
import {
  TelegramHealthMonitorProcessor,
  TelegramRetentionProcessor,
  TelegramReplicationProcessor,
} from './workers/telegram-background.processors';

// ── Controllers ───────────────────────────────────────────────────────────────
import { TelegramStorageController }     from './telegram-storage.controller';
import { TelegramAdminController }       from './admin/telegram-admin.controller';

// ── Queue names ───────────────────────────────────────────────────────────────
import { CanonicalQueue, DEFAULT_JOB_OPTIONS } from '../queue/canonical-queues';

const TELEGRAM_QUEUES = [
  CanonicalQueue.TG_UPLOAD,
  CanonicalQueue.TG_REPLICATION,
  CanonicalQueue.TG_HEALTH_MONITOR,
  CanonicalQueue.TG_RETENTION,
];

@Module({
  imports: [
    TelegramBotPoolModule,
    RealtimeModule,

    // In-memory multer (buffers are passed directly to upload service)
    MulterModule.register({ storage: undefined /* memoryStorage default */ }),

    // Register all Telegram queues with shared default options
    BullModule.registerQueue(
      ...TELEGRAM_QUEUES.map(name => ({
        name,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }))
    ),
  ],

  providers: [
    // Repository
    TelegramAssetRepository,

    // Core services
    TelegramDeduplicationService,
    TelegramUploadService,
    TelegramDownloadService,
    TelegramCDNService,
    TelegramRetentionService,
    TelegramStorageFacade,

    // Workers / Processors
    TelegramUploadProcessor,
    TelegramHealthMonitorProcessor,
    TelegramRetentionProcessor,
    TelegramReplicationProcessor,

    // Scheduler (cron jobs)
    SchedulerService,
  ],

  controllers: [
    TelegramStorageController,
    TelegramAdminController,
  ],

  exports: [
    TelegramStorageFacade,
    TelegramAssetRepository,
    TelegramCDNService,
    TelegramUploadService,
    TelegramBotPoolModule,
  ],
})
export class TelegramStorageModule {}
