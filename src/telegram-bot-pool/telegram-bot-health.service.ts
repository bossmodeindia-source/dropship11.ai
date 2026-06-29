/**
 * TelegramBotHealthService — monitors bot pool health.
 *
 * Responsibilities:
 *   - Periodic health checks via getMe API call.
 *   - Detect banned/revoked bots.
 *   - Detect flood-wait expiry and restore bot to active.
 *   - Emit alerts when bot pool degrades below threshold.
 *   - Update DB + Redis on status changes.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios                  from 'axios';
import { TelegramAssetRepository } from '../telegram-storage/telegram-asset.repository';
import { TelegramBotRoutingService } from './telegram-bot-routing.service';
import { EncryptionService }   from '../common/crypto/encryption.service';
import { AlertingService }     from '../alerting/alerting.service';
import { TelegramBotRow, BotHealth } from '../telegram-storage/telegram-storage.schema';

const BOT_API_BASE        = 'https://api.telegram.org';
const OVERLOAD_THRESHOLD  = 0.85; // 85% capacity = overloaded
const MIN_HEALTHY_BOTS    = 1;

@Injectable()
export class TelegramBotHealthService {
  private readonly logger = new Logger(TelegramBotHealthService.name);

  constructor(
    private readonly repo:       TelegramAssetRepository,
    private readonly routing:    TelegramBotRoutingService,
    private readonly encryption: EncryptionService,
    private readonly alerting:   AlertingService,
  ) {}

  /** Run health checks on all active bots */
  async checkAllBots(): Promise<void> {
    const bots = await this.repo.findActiveBots();
    this.logger.log(`Running health check on ${bots.length} bots`);

    const results = await Promise.allSettled(bots.map(b => this.checkBot(b)));

    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(`${failed}/${bots.length} bot health checks failed`);
    }

    // Alert if healthy bots below minimum
    const healthy = bots.filter(b => b.status === 'active').length;
    if (healthy < MIN_HEALTHY_BOTS) {
      await this.alerting.sendCritical({
        title:   '⚠️ Telegram Bot Pool Degraded',
        message: `Only ${healthy} healthy bots in pool. Minimum is ${MIN_HEALTHY_BOTS}. Consider provisioning more bots.`,
      });
    }
  }

  /** Run health check on a single bot */
  async checkBot(bot: TelegramBotRow): Promise<BotHealth> {
    const now = new Date();

    // Restore flood-wait bots whose timer has expired
    if (bot.status === 'flood_wait' && bot.flood_wait_until && bot.flood_wait_until < now) {
      await this.repo.clearBotFloodWait(bot.id);
      await this.routing.invalidateBotCache();
      bot.status = 'active';
      this.logger.log(`Bot @${bot.bot_username}: flood_wait expired — restored to active`);
    }

    // Live API check
    let apiOk = false;
    try {
      const token = this.encryption.decrypt(bot.bot_token_encrypted);
      const res   = await axios.get(`${BOT_API_BASE}/bot${token}/getMe`, { timeout: 8_000 });
      apiOk = res.data?.ok === true;
    } catch (err: any) {
      if (err?.response?.status === 401) {
        this.logger.error(`Bot @${bot.bot_username} is BANNED/REVOKED`);
        await this.repo.setBotStatus(bot.id, 'banned');
        await this.routing.invalidateBotCache();
        await this.alerting.sendCritical({
          title:   '🚫 Telegram Bot Banned',
          message: `Bot @${bot.bot_username} (id=${bot.id}) has been banned or token revoked. Pool reduced.`,
        });
        bot.status = 'banned';
      } else {
        this.logger.warn(`Bot @${bot.bot_username} health check failed: ${err?.message}`);
      }
    }

    // Update load status in DB
    const loadPct = bot.current_load / Math.max(1, bot.max_capacity);
    if (apiOk && loadPct >= OVERLOAD_THRESHOLD && bot.status === 'active') {
      await this.repo.setBotStatus(bot.id, 'overloaded');
      await this.routing.invalidateBotCache();
      this.logger.warn(`Bot @${bot.bot_username} marked OVERLOADED (${Math.round(loadPct * 100)}%)`);
    } else if (apiOk && loadPct < OVERLOAD_THRESHOLD && bot.status === 'overloaded') {
      await this.repo.setBotStatus(bot.id, 'active');
      await this.routing.invalidateBotCache();
      this.logger.log(`Bot @${bot.bot_username} load recovered — back to ACTIVE`);
    }

    if (apiOk) await this.repo.updateBotHealthCheck(bot.id);

    return {
      botId:       bot.id,
      botUsername: bot.bot_username,
      status:      bot.status,
      currentLoad: bot.current_load,
      maxCapacity: bot.max_capacity,
      loadPct:     Math.round(loadPct * 100),
      isFloodWait: bot.status === 'flood_wait',
      floodUntil:  bot.flood_wait_until ?? undefined,
      lastCheck:   apiOk ? now : bot.last_health_check,
    };
  }

  /** Get current health snapshot for all bots (admin dashboard) */
  async getPoolHealth(): Promise<BotHealth[]> {
    const bots = await this.repo.findAllBots();
    return bots.map(b => ({
      botId:       b.id,
      botUsername: b.bot_username,
      status:      b.status,
      currentLoad: b.current_load,
      maxCapacity: b.max_capacity,
      loadPct:     Math.round((b.current_load / Math.max(1, b.max_capacity)) * 100),
      isFloodWait: b.status === 'flood_wait',
      floodUntil:  b.flood_wait_until ?? undefined,
      lastCheck:   b.last_health_check,
    }));
  }
}
