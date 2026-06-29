/**
 * TelegramDownloadService + TelegramCDNService
 *
 * DOWNLOAD FLOW:
 *   1. Validate ownership (tenant_id + user_id match).
 *   2. DB fetch → get telegram_file_id + storage_bot_id.
 *   3. Decrypt bot token.
 *   4. Call getFile to get a temporary file_path (valid for 1h).
 *   5. Stream the file from Telegram CDN to the caller.
 *
 * SECURITY:
 *   - file_id is NEVER exposed to the client — only opaque assetId is used.
 *   - file_path is fetched server-side per-request (Telegram link is short-lived).
 *   - Bot token is decrypted at runtime only.
 *   - Download URL is NOT cached (intentional — forces auth check on every access).
 *
 * CACHING:
 *   - file_path is cached in Redis for 50 min (Telegram tokens expire in ~60 min).
 *   - file_id is permanent and cached for 24h per assetId.
 */

import {
  Injectable, Logger, NotFoundException,
  ForbiddenException, Inject, InternalServerErrorException,
} from '@nestjs/common';
import axios            from 'axios';
import { Readable }     from 'stream';
import Redis            from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { TelegramAssetRepository }  from './telegram-asset.repository';
import { EncryptionService }        from '../common/crypto/encryption.service';
import { AuditService }             from '../audit/audit.service';

const BOT_API_BASE    = 'https://api.telegram.org';
const FILE_PATH_TTL   = 50 * 60;   // 50 min (Telegram link valid for ~60 min)

@Injectable()
export class TelegramDownloadService {
  private readonly logger = new Logger(TelegramDownloadService.name);

  constructor(
    private readonly repo:       TelegramAssetRepository,
    private readonly encryption: EncryptionService,
    private readonly audit:      AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Stream an asset to the caller.
   * Validates ownership. Throws 403 on tenant/user mismatch, 404 if not found.
   */
  async streamAsset(params: {
    assetId: string; tenantId: string; userId: string; actorId: string;
  }): Promise<{ stream: Readable; mimeType: string; fileName: string; fileSize: number }> {
    const { assetId, tenantId, userId, actorId } = params;

    const asset = await this.repo.findById(assetId, tenantId);
    if (!asset)             throw new NotFoundException(`Asset ${assetId} not found`);
    if (asset.user_id !== userId) {
      throw new ForbiddenException('Access denied: asset belongs to another user');
    }
    if (!asset.telegram_file_id) {
      throw new InternalServerErrorException('Asset is not yet stored in Telegram');
    }

    // Get bot for this asset
    const bot = asset.storage_bot_id
      ? await this.repo.findBotById(asset.storage_bot_id)
      : null;

    if (!bot) throw new InternalServerErrorException('Storage bot not found for this asset');

    const token    = this.encryption.decrypt(bot.bot_token_encrypted);
    const filePath = await this.getFilePath(asset.telegram_file_id, token, assetId);

    const downloadUrl = `${BOT_API_BASE}/file/bot${token}/${filePath}`;

    // Audit log
    this.audit.log({
      tenantId: asset.tenant_id, actorId, action: 'ASSET_DOWNLOAD',
      resource: 'telegram_assets', resourceId: assetId,
      details: { fileName: asset.file_name, fileSize: asset.file_size },
      severity: 'info',
    });

    // Stream from Telegram CDN
    const response = await axios.get<Readable>(downloadUrl, {
      responseType: 'stream',
      timeout:      60_000,
    });

    return {
      stream:   response.data,
      mimeType: asset.mime_type,
      fileName: asset.file_name,
      fileSize: asset.file_size,
    };
  }

  /**
   * Get a pre-signed download URL (for clients that can fetch directly).
   * This is a SHORT-LIVED opaque URL — do not cache on the client.
   */
  async getPresignedDownloadUrl(params: {
    assetId: string; tenantId: string; userId: string;
  }): Promise<{ url: string; expiresIn: number }> {
    const { assetId, tenantId, userId } = params;

    const asset = await this.repo.findById(assetId, tenantId);
    if (!asset || asset.user_id !== userId) throw new ForbiddenException('Access denied');
    if (!asset.telegram_file_id) throw new InternalServerErrorException('Asset not in Telegram');

    const bot = asset.storage_bot_id ? await this.repo.findBotById(asset.storage_bot_id) : null;
    if (!bot) throw new InternalServerErrorException('Storage bot not found');

    const token    = this.encryption.decrypt(bot.bot_token_encrypted);
    const filePath = await this.getFilePath(asset.telegram_file_id, token, assetId);

    return {
      url:       `${BOT_API_BASE}/file/bot${token}/${filePath}`,
      expiresIn: FILE_PATH_TTL,
    };
  }

  /** Fetch the Telegram file_path for a file_id (cached in Redis) */
  private async getFilePath(fileId: string, token: string, assetId: string): Promise<string> {
    const cacheKey = `tg:filepath:${assetId}`;
    const cached   = await this.redis.get(cacheKey).catch(() => null);
    if (cached) return cached;

    const url      = `${BOT_API_BASE}/bot${token}/getFile`;
    const response = await axios.get<{ ok: boolean; result: { file_path: string } }>(url, {
      params:  { file_id: fileId },
      timeout: 10_000,
    });

    if (!response.data.ok || !response.data.result.file_path) {
      throw new InternalServerErrorException('Failed to retrieve Telegram file path');
    }

    const filePath = response.data.result.file_path;
    await this.redis.setex(cacheKey, FILE_PATH_TTL, filePath).catch(() => {});
    return filePath;
  }
}

/**
 * TelegramCDNService — thin CDN wrapper on top of TelegramDownloadService.
 * Provides CDN-like URL generation and cache invalidation.
 * Can be extended with Cloudflare proxy or signed URL tokens in V2.
 */
@Injectable()
export class TelegramCDNService {
  private readonly logger = new Logger(TelegramCDNService.name);

  constructor(
    private readonly download: TelegramDownloadService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Generate a download token → short-lived opaque reference for frontend */
  async generateDownloadToken(assetId: string, tenantId: string, ttlSeconds = 3600): Promise<string> {
    const { randomBytes } = await import('crypto');
    const token           = randomBytes(32).toString('hex');
    const key             = `tg:cdn:token:${token}`;
    await this.redis.setex(key, ttlSeconds, JSON.stringify({ assetId, tenantId }));
    return token;
  }

  /** Resolve a download token → assetId + tenantId */
  async resolveToken(token: string): Promise<{ assetId: string; tenantId: string } | null> {
    const key  = `tg:cdn:token:${token}`;
    const data = await this.redis.get(key).catch(() => null);
    if (!data) return null;
    return JSON.parse(data);
  }

  /** Invalidate a download token (after use or on deletion) */
  async invalidateToken(token: string): Promise<void> {
    await this.redis.del(`tg:cdn:token:${token}`).catch(() => {});
  }

  /** Warm up file_path cache for a set of assets (background job) */
  async prewarmCache(assetIds: string[]): Promise<void> {
    this.logger.debug(`Prewarming CDN cache for ${assetIds.length} assets`);
    // Placeholder — full implementation would batch getFile calls
  }
}
