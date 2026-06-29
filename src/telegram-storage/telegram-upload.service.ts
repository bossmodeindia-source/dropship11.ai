/**
 * TelegramUploadService — uploads files to Telegram via Bot API.
 *
 * Upload path:
 *   Buffer → multipart POST to api.telegram.org/bot{token}/send{Type}
 *   → Telegram CDN stores file
 *   → Returns file_id (permanent, reusable) + message_id
 *
 * Handles:
 *   - FLOOD_WAIT (429) → parse retry_after, set bot flood state, rethrow
 *   - Network errors  → bubble up for BullMQ retry
 *   - File size > 50MB → throws (MTProto required — V2 roadmap)
 *   - All file types via sendDocument (universal)
 */

import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios, { AxiosError }                             from 'axios';
import * as FormData                                     from 'form-data';
import { TelegramAssetRepository }   from './telegram-asset.repository';
import { TelegramBotRoutingService }  from '../telegram-bot-pool/telegram-bot-routing.service';
import { EncryptionService }          from '../common/crypto/encryption.service';
import { TelegramBotRow, ChannelType }from './telegram-storage.schema';

const BOT_API_BASE  = 'https://api.telegram.org';
const MAX_BOT_API_SIZE = 50 * 1024 * 1024; // 50 MB

export interface TelegramUploadResult {
  fileId:     string;
  messageId:  string;
  fileSize:   number;
  fileName:   string;
}

@Injectable()
export class TelegramUploadService {
  private readonly logger = new Logger(TelegramUploadService.name);

  constructor(
    private readonly repo:       TelegramAssetRepository,
    private readonly routing:    TelegramBotRoutingService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Upload a file buffer to the specified Telegram channel via a pool bot.
   * Returns the Telegram file_id and message_id.
   */
  async uploadToChannel(params: {
    fileBuffer: Buffer;
    fileName:   string;
    mimeType:   string;
    channelId:  string;     // decrypted numeric channel ID
    bot:        TelegramBotRow;
  }): Promise<TelegramUploadResult> {
    const { fileBuffer, fileName, mimeType, channelId, bot } = params;

    if (fileBuffer.length > MAX_BOT_API_SIZE) {
      throw new HttpException(
        `File size ${fileBuffer.length} exceeds Bot API limit (50 MB). MTProto upload required.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const token = this.encryption.decrypt(bot.bot_token_encrypted);
    const url   = `${BOT_API_BASE}/bot${token}/sendDocument`;

    const form  = new FormData();
    form.append('chat_id',  channelId);
    form.append('document', fileBuffer, { filename: fileName, contentType: mimeType });
    form.append('caption',  `[AI-Empire] ${fileName}`);

    this.logger.debug(`Uploading ${fileName} (${fileBuffer.length}B) via bot @${bot.bot_username}`);

    try {
      const response = await axios.post<TelegramSendResponse>(url, form, {
        headers:        form.getHeaders(),
        maxBodyLength:  MAX_BOT_API_SIZE + 1_000,
        timeout:        120_000,
      });

      const msg = response.data.result;
      const doc = msg.document ?? msg.video ?? msg.photo?.[0] ?? msg.audio;

      if (!doc?.file_id) {
        throw new Error('Telegram API returned no file_id in response');
      }

      this.logger.log(`Uploaded ${fileName} → file_id=${doc.file_id.slice(0, 12)}…`);

      return {
        fileId:    doc.file_id,
        messageId: String(msg.message_id),
        fileSize:  doc.file_size ?? fileBuffer.length,
        fileName,
      };
    } catch (err) {
      await this.handleTelegramError(err, bot.id);
      throw err;
    }
  }

  /**
   * Handle Telegram API errors.
   * 429 → parse retry_after, record flood wait on bot, rethrow so BullMQ retries.
   */
  private async handleTelegramError(err: unknown, botId: string): Promise<void> {
    if (!axios.isAxiosError(err)) return;

    const axErr = err as AxiosError<{ ok: false; description: string; parameters?: { retry_after?: number } }>;
    const status = axErr.response?.status;
    const data   = axErr.response?.data;

    if (status === 429) {
      const retryAfter = data?.parameters?.retry_after ?? 60;
      this.logger.warn(`Bot ${botId} hit FLOOD_WAIT — retry after ${retryAfter}s`);
      await this.repo.setBotFloodWait(botId, retryAfter);
      await this.routing.setFloodWait(botId, retryAfter);
      return;
    }

    if (status === 400 && data?.description?.includes('chat not found')) {
      this.logger.error(`Bot ${botId}: channel not found — channel may not have been joined`);
      return;
    }

    if (status === 401) {
      this.logger.error(`Bot ${botId}: unauthorized — token may be revoked`);
      await this.repo.setBotStatus(botId, 'banned');
      await this.routing.invalidateBotCache();
      return;
    }

    this.logger.error(`Telegram API error: ${status} ${data?.description ?? axErr.message}`);
  }
}

// ── Telegram API response types ───────────────────────────────────────────────
interface TelegramFile {
  file_id:   string;
  file_size?: number;
}
interface TelegramMessage {
  message_id: number;
  document?:  TelegramFile;
  video?:     TelegramFile;
  photo?:     TelegramFile[];
  audio?:     TelegramFile;
}
interface TelegramSendResponse {
  ok:     boolean;
  result: TelegramMessage;
}
