/**
 * TelegramChannelManagerService — manages private Telegram storage channels.
 *
 * Responsibilities:
 *   - Assign the correct channel for an asset type.
 *   - Rotate to a new channel if the current one is full/disabled.
 *   - Track channel capacity and health.
 *   - Decrypt channel IDs at runtime (never cached in plaintext).
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TelegramAssetRepository }    from '../telegram-storage/telegram-asset.repository';
import { EncryptionService }          from '../common/crypto/encryption.service';
import { TelegramChannelRow, ChannelType, ASSET_TO_CHANNEL, AssetType } from '../telegram-storage/telegram-storage.schema';

@Injectable()
export class TelegramChannelManagerService {
  private readonly logger = new Logger(TelegramChannelManagerService.name);

  constructor(
    private readonly repo:       TelegramAssetRepository,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Get the best active channel for a given asset type.
   * Returns { channelRecord, decryptedChannelId }.
   */
  async assignChannel(assetType: AssetType): Promise<{
    channelRecord: TelegramChannelRow;
    decryptedChannelId: string;
  }> {
    const channelType = ASSET_TO_CHANNEL[assetType] ?? 'general';
    let channel       = await this.repo.findActiveChannelByType(channelType);

    // Fallback: try general channel
    if (!channel && channelType !== 'general') {
      this.logger.warn(`No ${channelType} channel available — falling back to general`);
      channel = await this.repo.findActiveChannelByType('general');
    }

    if (!channel) {
      throw new ServiceUnavailableException(
        `No active Telegram storage channel available for type: ${channelType}. ` +
        'Please register a channel via POST /admin/storage/channels.'
      );
    }

    const decryptedChannelId = this.encryption.decrypt(channel.channel_id_encrypted);
    return { channelRecord: channel, decryptedChannelId };
  }

  /** Register a new private channel */
  async registerChannel(data: {
    channelName: string;
    rawChannelId: string;   // plain Telegram channel ID (e.g. -100xxxx)
    channelType: ChannelType;
  }): Promise<TelegramChannelRow> {
    const encryptedId = this.encryption.encrypt(data.rawChannelId);
    const row = await this.repo.createChannel({
      channelName:         data.channelName,
      channelIdEncrypted:  encryptedId,
      channelType:         data.channelType,
    });
    this.logger.log(`Channel registered: ${data.channelName} (type=${data.channelType})`);
    return row;
  }

  /** Increment channel asset counter after a successful upload */
  async recordUpload(channelId: string, fileSize: number): Promise<void> {
    await this.repo.incrementChannelAssets(channelId, fileSize);
  }

  /** Get all channels (admins) — channel IDs are NOT decrypted in list responses */
  async listChannels(): Promise<Omit<TelegramChannelRow, 'channel_id_encrypted'>[]> {
    const all = await this.repo.findAllChannels();
    return all.map(({ channel_id_encrypted: _omit, ...rest }) => rest);
  }

  /** Check channel health: mark full if asset_count >= max_assets */
  async auditChannelCapacity(): Promise<void> {
    const channels = await this.repo.findAllChannels();
    for (const ch of channels) {
      if (ch.asset_count >= ch.max_assets && ch.status === 'active') {
        this.logger.warn(`Channel ${ch.channel_name} is full (${ch.asset_count}/${ch.max_assets})`);
        // Could mark as full — for now just log; rotation is handled by findActiveChannelByType
      }
    }
  }
}
