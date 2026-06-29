/**
 * TelegramStorageFacade — top-level facade consumed by controllers.
 *
 * Single entry-point for all storage operations:
 *   - enqueue uploads (never blocks HTTP)
 *   - synchronous small-file uploads (< 5MB, bypass queue)
 *   - asset retrieval / streaming
 *   - deletion
 *   - metrics
 *
 * Coordinates: dedup → queue → pool → channel → upload → DB
 */

import {
  Injectable, Logger, BadRequestException,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue }                  from '@nestjs/bullmq';
import { Queue }                        from 'bullmq';
import { createHash }                   from 'crypto';
import { Readable }                     from 'stream';

import { TelegramAssetRepository }      from './telegram-asset.repository';
import { TelegramDeduplicationService } from './telegram-deduplication.service';
import { TelegramUploadService }        from './telegram-upload.service';
import { TelegramDownloadService, TelegramCDNService } from './telegram-download.service';
import { TelegramBotPoolService }       from '../telegram-bot-pool/telegram-bot-pool.service';
import { TelegramChannelManagerService } from '../telegram-bot-pool/telegram-channel-manager.service';
import { AuditService }                 from '../audit/audit.service';
import { RealtimeGateway }              from '../realtime/realtime.gateway';
import { DEFAULT_JOB_OPTIONS }          from '../queue/canonical-queues';
import {
  AssetType, AssetMeta, UploadedAsset, PoolMetrics,
  ASSET_TO_CHANNEL, UploadJobPayload,
} from './telegram-storage.schema';

export const TG_UPLOAD_QUEUE = 'telegram:upload';

const SYNC_UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 5MB — sync path
const MAX_FILE_SIZE_BYTES   = 50 * 1024 * 1024; // 50MB — Bot API hard limit

@Injectable()
export class TelegramStorageFacade {
  private readonly logger = new Logger(TelegramStorageFacade.name);

  constructor(
    private readonly repo:     TelegramAssetRepository,
    private readonly dedup:    TelegramDeduplicationService,
    private readonly upload:   TelegramUploadService,
    private readonly download: TelegramDownloadService,
    private readonly cdn:      TelegramCDNService,
    private readonly pool:     TelegramBotPoolService,
    private readonly channels: TelegramChannelManagerService,
    private readonly audit:    AuditService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue(TG_UPLOAD_QUEUE) private readonly uploadQueue: Queue,
  ) {}

  // ── UPLOAD ────────────────────────────────────────────────────────────────

  /**
   * Enqueue an asset for upload.
   *
   * - Files < 5MB: uploaded synchronously (returns immediately with stored status).
   * - Files ≥ 5MB: queued for background processing (returns pending status).
   * - All files: deduplication checked before any upload attempt.
   */
  async enqueueUpload(params: {
    tenantId:   string;
    userId:     string;
    fileBuffer: Buffer;
    fileName:   string;
    mimeType:   string;
    assetType:  AssetType;
    projectId?: string;
    campaignId?: string;
    tags?:      Record<string, string>;
  }): Promise<UploadedAsset> {
    const { tenantId, userId, fileBuffer, fileName, mimeType, assetType } = params;

    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `File size ${fileBuffer.length} exceeds maximum (50 MB). Use chunked upload API for large files.`
      );
    }

    // Compute checksum
    const checksum = createHash('sha256').update(fileBuffer).digest('hex');

    // Deduplication check
    const duplicate = await this.dedup.findDuplicate(tenantId, checksum);
    if (duplicate?.telegram_file_id) {
      this.logger.log(`Dedup hit: ${fileName} → reuse asset ${duplicate.id}`);
      this.audit.log({
        tenantId, actorId: userId, action: 'ASSET_DEDUP_REUSE',
        resource: 'telegram_assets', resourceId: duplicate.id,
        details: { fileName, checksum: checksum.slice(0, 8) }, severity: 'info',
      });
      return {
        id:            duplicate.id,
        fileId:        duplicate.telegram_file_id,
        messageId:     duplicate.telegram_message_id ?? '',
        channelId:     '',
        storageStatus: duplicate.storage_status,
        deduped:       true,
      };
    }

    // Create pending asset record
    const assetRow = await this.repo.createAsset({
      tenantId, userId,
      projectId:  params.projectId,
      campaignId: params.campaignId,
      assetType,
      fileName,
      mimeType,
      fileSize: fileBuffer.length,
      checksum,
      tags:     params.tags,
    });

    this.audit.log({
      tenantId, actorId: userId, action: 'ASSET_UPLOAD_INITIATED',
      resource: 'telegram_assets', resourceId: assetRow.id,
      details: { fileName, fileSize: fileBuffer.length, assetType }, severity: 'info',
    });

    // Sync path for small files
    if (fileBuffer.length <= SYNC_UPLOAD_MAX_BYTES) {
      return this.uploadSync(assetRow.id, tenantId, userId, fileBuffer, fileName, mimeType, assetType, checksum);
    }

    // Async queue path for larger files
    const payload: UploadJobPayload = {
      assetId:    assetRow.id,
      tenantId,
      userId,
      fileBuffer: fileBuffer.toString('base64'),
      fileName,
      mimeType,
      assetType,
      checksum,
      projectId:  params.projectId,
      campaignId: params.campaignId,
    };

    await this.uploadQueue.add('upload', payload, {
      ...DEFAULT_JOB_OPTIONS,
      jobId:    `tg-upload-${assetRow.id}`,
      attempts: 5,
      backoff:  { type: 'exponential', delay: 5_000 },
    });

    this.logger.log(`Asset ${assetRow.id} queued for background upload`);

    return {
      id:            assetRow.id,
      fileId:        '',
      messageId:     '',
      channelId:     '',
      storageStatus: 'pending',
      deduped:       false,
    };
  }

  /** Synchronous upload path for small files */
  private async uploadSync(
    assetId:   string,
    tenantId:  string,
    userId:    string,
    buffer:    Buffer,
    fileName:  string,
    mimeType:  string,
    assetType: AssetType,
    checksum:  string,
  ): Promise<UploadedAsset> {
    const channelType = ASSET_TO_CHANNEL[assetType] ?? 'general';

    await this.repo.updateAssetStatus(assetId, 'uploading');

    const { channelRecord, decryptedChannelId } = await this.channels.assignChannel(assetType);
    const bot = await this.pool.selectBot(channelType);

    await this.pool.acquireSlot(bot.id);

    try {
      const result = await this.upload.uploadToChannel({
        fileBuffer: buffer, fileName, mimeType,
        channelId:  decryptedChannelId, bot,
      });

      await this.repo.updateAssetUploaded(assetId, {
        telegramFileId:    result.fileId,
        telegramMessageId: result.messageId,
        telegramChannelId: channelRecord.channel_id_encrypted,
        storageBotId:      bot.id,
        channelRecordId:   channelRecord.id,
      });

      await this.repo.incrementBotLoad(bot.id, result.fileSize);
      await this.channels.recordUpload(channelRecord.id, result.fileSize);
      await this.dedup.cacheChecksum(tenantId, checksum, assetId);

      this.realtime.emitToTenant(tenantId, 'upload_complete', { assetId, deduped: false });

      return {
        id:            assetId,
        fileId:        result.fileId,
        messageId:     result.messageId,
        channelId:     channelRecord.id,
        storageStatus: 'stored',
        deduped:       false,
      };
    } catch (err: any) {
      await this.repo.updateAssetStatus(assetId, 'failed');
      this.realtime.emitToTenant(tenantId, 'upload_failed', { assetId, reason: err.message });
      throw err;
    } finally {
      await this.pool.releaseSlot(bot.id);
    }
  }

  // ── DOWNLOAD ──────────────────────────────────────────────────────────────

  async streamAsset(params: {
    assetId: string; tenantId: string; userId: string; actorId: string;
  }): Promise<{ stream: Readable; mimeType: string; fileName: string; fileSize: number }> {
    return this.download.streamAsset(params);
  }

  async getDownloadToken(params: {
    assetId: string; tenantId: string; userId: string;
  }): Promise<{ token: string; expiresIn: number }> {
    // Validate ownership first
    const asset = await this.repo.findByIdOrThrow(params.assetId, params.tenantId);
    if (asset.user_id !== params.userId) {
      throw new NotFoundException('Asset not found');
    }
    const token = await this.cdn.generateDownloadToken(params.assetId, params.tenantId);
    return { token, expiresIn: 3600 };
  }

  // ── ASSET MANAGEMENT ──────────────────────────────────────────────────────

  async getAsset(assetId: string, tenantId: string): Promise<AssetMeta> {
    const row = await this.repo.findByIdOrThrow(assetId, tenantId);
    return {
      id:           row.id,
      tenantId:     row.tenant_id,
      userId:       row.user_id,
      assetType:    row.asset_type,
      fileName:     row.file_name,
      mimeType:     row.mime_type,
      fileSize:     row.file_size,
      storageStatus: row.storage_status,
      isArchived:   row.is_archived,
      createdAt:    row.created_at,
      projectId:    row.project_id ?? undefined,
      campaignId:   row.campaign_id ?? undefined,
      tags:         row.tags,
    };
  }

  async listUserAssets(
    tenantId: string, userId: string, page = 1, limit = 20
  ): Promise<{ assets: AssetMeta[]; total: number; page: number; limit: number }> {
    const offset        = (page - 1) * limit;
    const { rows, total } = await this.repo.listByUser(tenantId, userId, { limit, offset });
    return { assets: rows, total, page, limit };
  }

  async listProjectAssets(
    tenantId: string, projectId: string, page = 1, limit = 20
  ): Promise<{ assets: AssetMeta[]; total: number; page: number; limit: number }> {
    const offset        = (page - 1) * limit;
    const { rows, total } = await this.repo.listByProject(tenantId, projectId, { limit, offset });
    return { assets: rows, total, page, limit };
  }

  async listCampaignAssets(
    tenantId: string, campaignId: string, page = 1, limit = 20
  ): Promise<{ assets: AssetMeta[]; total: number; page: number; limit: number }> {
    const offset        = (page - 1) * limit;
    const { rows, total } = await this.repo.listByCampaign(tenantId, campaignId, { limit, offset });
    return { assets: rows, total, page, limit };
  }

  async deleteAsset(assetId: string, tenantId: string, userId: string, actorId: string): Promise<void> {
    const row = await this.repo.findByIdOrThrow(assetId, tenantId);
    if (row.user_id !== userId) throw new NotFoundException('Asset not found');

    await this.repo.softDelete(assetId, tenantId);
    await this.dedup.invalidateChecksum(tenantId, row.checksum);

    this.audit.log({
      tenantId, actorId, action: 'ASSET_DELETED',
      resource: 'telegram_assets', resourceId: assetId,
      details: { fileName: row.file_name }, severity: 'warn',
    });
  }

  // ── POOL METRICS ──────────────────────────────────────────────────────────

  async getPoolMetrics(): Promise<PoolMetrics> {
    return this.pool.getMetrics();
  }
}
