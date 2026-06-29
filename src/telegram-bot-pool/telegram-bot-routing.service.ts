/**
 * TelegramBotRoutingService — Load-aware bot selection engine.
 *
 * Routing strategies (applied in priority order):
 *   1. Channel affinity   — prefer bots already assigned to the target channel
 *   2. Load balancing     — pick bot with lowest current_load / max_capacity ratio
 *   3. Flood-wait filter  — skip bots in flood_wait state
 *   4. Status filter      — skip disabled/banned bots
 *
 * Redis is used for atomic load counters to avoid races with DB writes.
 * DB remains the source of truth; Redis counters are self-healing on restart.
 */

import { Injectable, Logger, ServiceUnavailableException, Inject } from '@nestjs/common';
import Redis                       from 'ioredis';
import { REDIS_CLIENT }            from '../common/redis/redis.module';
import { TelegramAssetRepository } from '../telegram-storage/telegram-asset.repository';
import { TelegramBotRow, ChannelType } from '../telegram-storage/telegram-storage.schema';

const LOAD_CACHE_TTL   = 30;   // seconds
const BOT_LIST_CACHE   = 60;   // seconds
const BOT_LIST_KEY     = 'tg:pool:bots';

@Injectable()
export class TelegramBotRoutingService {
  private readonly logger = new Logger(TelegramBotRoutingService.name);

  constructor(
    private readonly repo: TelegramAssetRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Select the best available bot for an upload to the given channel type.
   * Throws ServiceUnavailableException if no bot is available.
   */
  async selectBot(channelType: ChannelType): Promise<TelegramBotRow> {
    const bots = await this.getActiveBots();

    if (bots.length === 0) {
      throw new ServiceUnavailableException(
        'No Telegram storage bots available. Please provision a bot via /admin/storage/bots/provision'
      );
    }

    // Filter: not flood-wait
    const now = new Date();
    const eligible = bots.filter(b => {
      if (!b.is_active) return false;
      if (b.status === 'banned' || b.status === 'disabled') return false;
      if (b.status === 'flood_wait' && b.flood_wait_until && b.flood_wait_until > now) return false;
      return true;
    });

    if (eligible.length === 0) {
      throw new ServiceUnavailableException(
        'All Telegram storage bots are in flood_wait or disabled. Retry shortly.'
      );
    }

    // Prefer bots assigned to this channel type (channel affinity)
    const affine = eligible.filter(b =>
      b.assigned_channels?.some((ch: { channelId: string; channelType: ChannelType }) => ch.channelType === channelType)
    );
    const pool   = affine.length > 0 ? affine : eligible;

    // Sort by load ratio ascending
    const sorted = await this.sortByLoad(pool);
    const best   = sorted[0];

    this.logger.debug(
      `Routed to bot ${best.bot_username} (load=${best.current_load}/${best.max_capacity}) for channel=${channelType}`
    );
    return best;
  }

  /** Get active bots (Redis-cached for 60s) */
  async getActiveBots(): Promise<TelegramBotRow[]> {
    const cached = await this.redis.get(BOT_LIST_KEY).catch(() => null);
    if (cached) {
      try { return JSON.parse(cached) as TelegramBotRow[]; } catch { /* fall through */ }
    }

    const bots = await this.repo.findActiveBots();
    await this.redis.setex(BOT_LIST_KEY, BOT_LIST_CACHE, JSON.stringify(bots)).catch(() => {});
    return bots;
  }

  /** Invalidate the bot list cache (call after provisioning/disabling a bot) */
  async invalidateBotCache(): Promise<void> {
    await this.redis.del(BOT_LIST_KEY).catch(() => {});
  }

  /**
   * Atomically increment Redis load counter for a bot.
   * Returns the new load count.
   */
  async acquireSlot(botId: string): Promise<number> {
    const key  = `tg:bot:load:${botId}`;
    const load = await this.redis.incr(key);
    await this.redis.expire(key, 3600).catch(() => {}); // self-healing TTL
    return load;
  }

  /** Decrement Redis load counter after upload completes/fails */
  async releaseSlot(botId: string): Promise<void> {
    const key = `tg:bot:load:${botId}`;
    await this.redis.decr(key).catch(() => {});
  }

  /** Track flood-wait in Redis (fast path before DB write) */
  async setFloodWait(botId: string, retryAfterSeconds: number): Promise<void> {
    const key = `tg:bot:floodwait:${botId}`;
    await this.redis.setex(key, retryAfterSeconds + 5, '1').catch(() => {});
    await this.invalidateBotCache();
  }

  async isFloodWait(botId: string): Promise<boolean> {
    const key = `tg:bot:floodwait:${botId}`;
    return (await this.redis.exists(key).catch(() => 0)) === 1;
  }

  /** Sort bots by Redis load ratio (falls back to DB load if Redis key missing) */
  private async sortByLoad(bots: TelegramBotRow[]): Promise<TelegramBotRow[]> {
    const keys  = bots.map(b => `tg:bot:load:${b.id}`);
    const loads = await this.redis.mget(...keys).catch(() => []);

    return bots
      .map((b, i) => {
        const redisLoad = loads[i] ? parseInt(loads[i]!, 10) : b.current_load;
        return { bot: b, ratio: redisLoad / Math.max(1, b.max_capacity) };
      })
      .sort((a, z) => a.ratio - z.ratio)
      .map(x => x.bot);
  }

  /** Select a bot for the given tenant (alias for selectBot with MEDIA channel). */
  async routeForTenant(tenantId: string): Promise<{ channelId: string; bot: TelegramBotRow } | null> {
    try {
      const bot = await this.selectBot('MEDIA' as ChannelType);
      const channelEntry = bot.assigned_channels.find(c => c.channelType === ('MEDIA' as ChannelType));
      const channelId = channelEntry?.channelId ?? bot.assigned_channels[0]?.channelId ?? '';
      if (!channelId) return null;
      return { channelId, bot };
    } catch {
      return null;
    }
  }
}
