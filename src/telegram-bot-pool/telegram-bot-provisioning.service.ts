/**
 * TelegramBotProvisioningService — auto-provisions Telegram storage bots.
 *
 * Uses GramJS (MTProto) to communicate with BotFather and create new bots.
 * Requires: npm install telegram input
 *
 * Flow:
 *   1. Load MTProto session from DB (encrypted).
 *   2. Connect to Telegram via GramJS TelegramClient.
 *   3. Open conversation with @BotFather.
 *   4. Send /newbot, provide name + username.
 *   5. Extract token from BotFather response.
 *   6. Encrypt token and store in DB.
 *   7. Add bot to routing pool.
 *
 * IMPORTANT:
 *   - Session string is decrypted at runtime only.
 *   - Bot token is encrypted before storage.
 *   - MTProto session must be pre-registered by admin via POST /admin/storage/mtproto.
 *   - The session phone must have Telegram Premium or be an account with
 *     permissions to use BotFather at scale.
 */

import { Injectable, Logger, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { Pool }                    from 'pg';
import { DB_POOL }                 from '../common/database/database.module';
import { EncryptionService }       from '../common/crypto/encryption.service';
import { TelegramAssetRepository } from '../telegram-storage/telegram-asset.repository';
import { TelegramBotRoutingService } from './telegram-bot-routing.service';
import { AuditService }            from '../audit/audit.service';
import { AlertingService }         from '../alerting/alerting.service';
import { TelegramBotRow }          from '../telegram-storage/telegram-storage.schema';

@Injectable()
export class TelegramBotProvisioningService {
  private readonly logger = new Logger(TelegramBotProvisioningService.name);

  constructor(
    private readonly repo:       TelegramAssetRepository,
    private readonly routing:    TelegramBotRoutingService,
    private readonly encryption: EncryptionService,
    private readonly audit:      AuditService,
    private readonly alerting:   AlertingService,
    @Inject(DB_POOL) private readonly db: Pool,
  ) {}

  /**
   * Register an existing bot manually (most common path).
   * Admins create bots via BotFather themselves and register the token here.
   */
  async registerExistingBot(params: {
    botName:    string;
    botUsername: string;
    botToken:   string;    // plaintext — encrypted before storage
    maxCapacity?: number;
    actorId:    string;
  }): Promise<TelegramBotRow> {
    // Validate token by calling getMe
    const isValid = await this.validateBotToken(params.botToken);
    if (!isValid) {
      throw new BadRequestException('Invalid bot token — getMe returned ok: false');
    }

    const tokenEncrypted = this.encryption.encrypt(params.botToken);
    const bot = await this.repo.createBot({
      botName:           params.botName,
      botUsername:       params.botUsername,
      botTokenEncrypted: tokenEncrypted,
      maxCapacity:       params.maxCapacity ?? 100,
    });

    await this.routing.invalidateBotCache();

    this.audit.log({
      tenantId:   '__system__',
      actorId:    params.actorId,
      action:     'BOT_PROVISIONED',
      resource:   'telegram_storage_bots',
      resourceId: bot.id,
      details:    { botName: params.botName, botUsername: params.botUsername },
      severity:   'warn',
    });

    this.logger.log(`Bot @${params.botUsername} registered in pool (id=${bot.id})`);

    await this.alerting.sendInfo({
      title:   '🤖 Storage Bot Added',
      message: `@${params.botUsername} added to Telegram storage pool (capacity=${params.maxCapacity ?? 100})`,
    });

    return bot;
  }

  /**
   * Auto-provision a new bot via BotFather (MTProto).
   *
   * Requires: npm install telegram input
   * The `telegram` package must be installed separately — it's a large dependency
   * that is only used for provisioning, not for regular uploads.
   *
   * IMPORTANT: This is an async, interactive flow. BotFather may take
   * several seconds between messages. The job timeout must be generous (> 60s).
   */
  async autoprovisionBot(params: {
    botName:     string;
    botUsername: string;
    actorId:    string;
  }): Promise<TelegramBotRow> {
    this.logger.log(`Starting MTProto auto-provisioning for @${params.botUsername}`);

    // Load MTProto session
    const session = await this.loadMtprotoSession();
    if (!session) {
      throw new NotFoundException(
        'No MTProto session configured. Register one via POST /admin/storage/mtproto'
      );
    }

    let botToken: string;
    try {
      // Dynamically import GramJS to avoid loading it at startup
      const { TelegramClient } = await import('telegram');
      const { StringSession }  = await import('telegram/sessions');
      const { NewMessage }     = await import('telegram/events');

      const client = new TelegramClient(
        new StringSession(session.sessionString),
        parseInt(session.apiId, 10),
        session.apiHash,
        { connectionRetries: 3, useWSS: true },
      );

      await client.connect();
      botToken = await this.converseBotFather(client, params.botName, params.botUsername);
      await client.disconnect();
    } catch (err: any) {
      this.logger.error(`MTProto provisioning failed: ${err.message}`);
      throw new BadRequestException(`Auto-provisioning failed: ${err.message}`);
    }

    return this.registerExistingBot({
      botName:     params.botName,
      botUsername: params.botUsername,
      botToken,
      actorId:     params.actorId,
    });
  }

  /** MTProto conversation with BotFather to create a new bot */
  private async converseBotFather(client: any, botName: string, botUsername: string): Promise<string> {
    const BOTFATHER = 'BotFather';
    const wait      = (ms: number) => new Promise(r => setTimeout(r, ms));

    // Send /newbot
    await client.sendMessage(BOTFATHER, { message: '/newbot' });
    await wait(3_000);

    // Send bot display name
    await client.sendMessage(BOTFATHER, { message: botName });
    await wait(3_000);

    // Send username (must end with 'bot')
    const safeUsername = botUsername.endsWith('bot') ? botUsername : `${botUsername}bot`;
    await client.sendMessage(BOTFATHER, { message: safeUsername });
    await wait(5_000);

    // Read the last message from BotFather which contains the token
    const messages = await client.getMessages(BOTFATHER, { limit: 3 });
    const text      = messages.map((m: any) => m.text ?? m.message ?? '').join('\n');

    // Extract token: format is like 1234567890:AAFxyz...
    const tokenMatch = text.match(/(\d+:[A-Za-z0-9_-]{35,})/);
    if (!tokenMatch) {
      this.logger.error(`BotFather response did not contain a token:\n${text.slice(0, 300)}`);
      throw new Error('BotFather did not return a token. Username may already be taken.');
    }

    return tokenMatch[1];
  }

  /** Register MTProto session (admin one-time setup) */
  async registerMtprotoSession(params: {
    sessionName:   string;
    apiId:         string;
    apiHash:       string;
    sessionString: string;
    phoneNumber:   string;
    actorId:       string;
  }): Promise<void> {
    const { rows: existing } = await this.db.query(
      `SELECT id FROM telegram_mtproto_sessions WHERE session_name = $1`, [params.sessionName]
    );

    const encrypted = {
      apiId:         this.encryption.encrypt(params.apiId),
      apiHash:       this.encryption.encrypt(params.apiHash),
      sessionString: this.encryption.encrypt(params.sessionString),
    };

    if (existing.length > 0) {
      await this.db.query(`
        UPDATE telegram_mtproto_sessions SET
          api_id_encrypted       = $2,
          api_hash_encrypted     = $3,
          session_string_encrypted = $4
        WHERE session_name = $1
      `, [params.sessionName, encrypted.apiId, encrypted.apiHash, encrypted.sessionString]);
    } else {
      await this.db.query(`
        INSERT INTO telegram_mtproto_sessions
          (session_name, api_id_encrypted, api_hash_encrypted, session_string_encrypted, phone_number)
        VALUES ($1, $2, $3, $4, $5)
      `, [params.sessionName, encrypted.apiId, encrypted.apiHash, encrypted.sessionString, params.phoneNumber]);
    }

    this.audit.log({
      tenantId: '__system__', actorId: params.actorId,
      action: 'MTPROTO_SESSION_REGISTERED', resource: 'telegram_mtproto_sessions',
      details: { sessionName: params.sessionName, phoneNumber: params.phoneNumber },
      severity: 'critical',
    });

    this.logger.log(`MTProto session '${params.sessionName}' registered`);
  }

  /** Disable/enable a bot in the pool */
  async setBotEnabled(botId: string, enabled: boolean, actorId: string): Promise<void> {
    await this.repo.setBotActive(botId, enabled);
    await this.routing.invalidateBotCache();
    this.audit.log({
      tenantId: '__system__', actorId,
      action: enabled ? 'BOT_ENABLED' : 'BOT_DISABLED',
      resource: 'telegram_storage_bots', resourceId: botId,
      severity: 'warn',
    });
    this.logger.log(`Bot ${botId} ${enabled ? 'enabled' : 'disabled'} by ${actorId}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async validateBotToken(token: string): Promise<boolean> {
    try {
      const { default: axios } = await import('axios');
      const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8_000 });
      return res.data?.ok === true;
    } catch {
      return false;
    }
  }

  private async loadMtprotoSession(): Promise<{
    sessionString: string; apiId: string; apiHash: string;
  } | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM telegram_mtproto_sessions WHERE status = 'active' LIMIT 1`
    );
    if (!rows[0]) return null;
    return {
      sessionString: this.encryption.decrypt(rows[0].session_string_encrypted),
      apiId:         this.encryption.decrypt(rows[0].api_id_encrypted),
      apiHash:       this.encryption.decrypt(rows[0].api_hash_encrypted),
    };
  }
}
