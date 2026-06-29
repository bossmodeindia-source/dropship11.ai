/**
 * Telegram background processors:
 *   TelegramHealthMonitorProcessor  — periodic bot health checks
 *   TelegramRetentionProcessor      — expired asset cleanup + cold archival
 *   TelegramReplicationProcessor    — async R2/S3 archival
 */

import { Processor } from '@nestjs/bullmq';
import { Logger }              from '@nestjs/common';
import { Job }                 from 'bullmq';
import { TelegramBotHealthService } from '../../telegram-bot-pool/telegram-bot-health.service';
import { TelegramRetentionService } from '../telegram-retention.service';
import { StorageService }           from '../../storage/storage.service';
import { TelegramAssetRepository }  from '../telegram-asset.repository';
import { TelegramDownloadService }  from '../telegram-download.service';
import { AlertingService }          from '../../alerting/alerting.service';
import { ReplicationJobPayload, HealthMonitorJobPayload } from '../telegram-storage.schema';

export const TG_HEALTH_QUEUE      = 'telegram:health-monitor';
export const TG_RETENTION_QUEUE   = 'telegram:retention';
export const TG_REPLICATION_QUEUE = 'telegram:replication';

// ── Health Monitor ────────────────────────────────────────────────────────────
@Processor(TG_HEALTH_QUEUE)
export class TelegramHealthMonitorProcessor {
  private readonly logger = new Logger(TelegramHealthMonitorProcessor.name);

  constructor(private readonly health: TelegramBotHealthService) {}

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleHealthCheck(job: Job<HealthMonitorJobPayload>): Promise<void> {
    this.logger.debug(`[job=${job.id}] Running bot pool health check`);
    await this.health.checkAllBots();
  }
}

// ── Retention ─────────────────────────────────────────────────────────────────
@Processor(TG_RETENTION_QUEUE)
export class TelegramRetentionProcessor {
  private readonly logger = new Logger(TelegramRetentionProcessor.name);

  constructor(private readonly retention: TelegramRetentionService) {}

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handlePurgeExpired(job: Job): Promise<void> {
    this.logger.debug(`[job=${job.id}] Purging expired assets`);
    const result = await this.retention.purgeExpired();
    this.logger.log(`[job=${job.id}] Purged ${result.purged} expired assets`);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleArchiveCold(job: Job): Promise<void> {
    this.logger.debug(`[job=${job.id}] Archiving cold assets`);
    const result = await this.retention.archiveColdAssets();
    this.logger.log(`[job=${job.id}] archived=${result.archived} failed=${result.failed}`);
  }

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleRepairBroken(job: Job): Promise<void> {
    this.logger.debug(`[job=${job.id}] Repairing broken asset references`);
    const result = await this.retention.repairBrokenReferences();
    this.logger.log(`[job=${job.id}] Repaired ${result.repaired} broken references`);
  }
}

// ── R2/S3 Replication ─────────────────────────────────────────────────────────
@Processor(TG_REPLICATION_QUEUE)
export class TelegramReplicationProcessor {
  private readonly logger = new Logger(TelegramReplicationProcessor.name);

  constructor(
    private readonly storage:  StorageService,
    private readonly repo:     TelegramAssetRepository,
    private readonly download: TelegramDownloadService,
    private readonly alerting: AlertingService,
  ) {}

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleReplication(job: Job<ReplicationJobPayload>): Promise<void> {
    const { assetId, tenantId, fileName, mimeType } = job.data;
    this.logger.debug(`[job=${job.id}] Replicating asset ${assetId} → R2/S3`);

    const asset = await this.repo.findById(assetId, tenantId);
    if (!asset || asset.is_archived) {
      this.logger.debug(`[job=${job.id}] Asset ${assetId} already archived or not found — skipping`);
      return;
    }

    try {
      const { stream } = await this.download.streamAsset({
        assetId, tenantId, userId: asset.user_id, actorId: '__replication__',
      });

      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);

      const archiveKey = `telegram-backup/${tenantId}/${assetId}/${fileName}`;
      await this.storage.upload(
        tenantId,
        'exports',
        `telegram-backup/${assetId}/${fileName}`,
        buffer,
        mimeType,
      );

      await this.repo.markArchived(assetId, `telegram-backup/${assetId}/${fileName}`, 'r2-archive');
      this.logger.log(`[job=${job.id}] Replicated ${assetId} → ${archiveKey}`);

    } catch (err: any) {
      this.logger.error(`[job=${job.id}] Replication failed for ${assetId}: ${err.message}`);
      if (job.attemptsMade >= 2) {
        await this.alerting.sendWarn({
          title:   '⚠️ Telegram Asset Replication Failed',
          message: `Asset ${assetId} could not be replicated to R2/S3 after 3 attempts: ${err.message}`,
        });
      }
      throw err;
    }
  }
}
