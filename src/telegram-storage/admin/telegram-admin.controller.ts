/**
 * TelegramAdminController — admin endpoints for bot pool management.
 *
 * POST /admin/storage/bots/register      Register an existing bot token
 * POST /admin/storage/bots/autoprovision Auto-provision via BotFather (MTProto)
 * GET  /admin/storage/bots               List all bots
 * POST /admin/storage/bots/:id/disable   Disable a bot
 * POST /admin/storage/bots/:id/enable    Enable a bot
 * POST /admin/storage/channels           Register a storage channel
 * GET  /admin/storage/channels           List all channels
 * POST /admin/storage/mtproto            Register MTProto session
 * GET  /admin/storage/metrics            Pool-wide metrics
 * POST /admin/storage/health-check       Trigger immediate health check
 * GET  /admin/storage/assets             Admin-wide asset search
 *
 * Requires: JwtAuthGuard + RolesGuard (admin)
 */

import {
  Controller, Post, Get, Param, Body,
  UseGuards, Req, HttpCode, HttpStatus, Query,
  ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard }                  from '../../common/guards/jwt-auth.guard';
import { RolesGuard }                    from '../../common/guards/roles.guard';
import { Roles }                         from '../../common/decorators/roles.decorator';
import { TelegramBotPoolService }        from '../../telegram-bot-pool/telegram-bot-pool.service';
import { TelegramBotProvisioningService } from '../../telegram-bot-pool/telegram-bot-provisioning.service';
import { TelegramBotHealthService }      from '../../telegram-bot-pool/telegram-bot-health.service';
import { TelegramChannelManagerService } from '../../telegram-bot-pool/telegram-channel-manager.service';
import { TelegramStorageFacade }   from '../telegram-storage-facade.service';
import { AdminSetMtprotoDto, ProvisionBotDto } from '../dto/upload-asset.dto';
import { ChannelType }                   from '../telegram-storage.schema';

class RegisterBotDto {
  botName!:    string;
  botUsername!: string;
  botToken!:   string;
  maxCapacity?: number;
}

class RegisterChannelDto {
  channelName!:  string;
  rawChannelId!: string;
  channelType!:  ChannelType;
}

@ApiTags('Admin — Storage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
@Controller('admin/storage')
export class TelegramAdminController {
  constructor(
    private readonly pool:         TelegramBotPoolService,
    private readonly provisioning: TelegramBotProvisioningService,
    private readonly health:       TelegramBotHealthService,
    private readonly channels:     TelegramChannelManagerService,
    private readonly orchestrator: TelegramStorageFacade,
  ) {}

  // ── Bot Management ─────────────────────────────────────────────────────────

  @Post('bots/register')
  @ApiOperation({ summary: 'Register an existing Telegram bot into the storage pool' })
  async registerBot(@Body() dto: RegisterBotDto, @Req() req: any) {
    const bot = await this.pool.registerBot({
      botName:     dto.botName,
      botUsername: dto.botUsername,
      botToken:    dto.botToken,
      maxCapacity: dto.maxCapacity ?? 100,
      actorId:     req.user.sub,
    });
    return { success: true, bot: { id: bot.id, username: bot.bot_username, status: bot.status } };
  }

  @Post('bots/autoprovision')
  @ApiOperation({
    summary: 'Auto-provision a new bot via BotFather (requires MTProto session)',
    description: 'Requires a registered MTProto session. Bot username must end with "bot". Slow operation (10-15s).',
  })
  async autoprovisionBot(@Body() dto: ProvisionBotDto, @Req() req: any) {
    const bot = await this.pool.autoprovision({
      botName:     dto.botName,
      botUsername: dto.botUsername,
      actorId:     req.user.sub,
    });
    return { success: true, bot: { id: bot.id, username: bot.bot_username, status: bot.status } };
  }

  @Get('bots')
  @ApiOperation({ summary: 'List all bots in the storage pool' })
  async listBots() {
    const bots = await this.pool.listBots();
    // Strip encrypted token from response
    return bots.map(({ bot_token_encrypted: _omit, ...b }) => b);
  }

  @Post('bots/:id/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disable a bot (remove from routing)' })
  async disableBot(@Param('id') id: string, @Req() req: any) {
    await this.pool.setBotEnabled(id, false, req.user.sub);
  }

  @Post('bots/:id/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Re-enable a disabled bot' })
  async enableBot(@Param('id') id: string, @Req() req: any) {
    await this.pool.setBotEnabled(id, true, req.user.sub);
  }

  // ── Channel Management ─────────────────────────────────────────────────────

  @Post('channels')
  @ApiOperation({
    summary: 'Register a private Telegram channel as a storage bucket',
    description: 'channelType maps asset types to channels. rawChannelId is encrypted at rest.',
  })
  async registerChannel(@Body() dto: RegisterChannelDto) {
    const channel = await this.channels.registerChannel({
      channelName:  dto.channelName,
      rawChannelId: dto.rawChannelId,
      channelType:  dto.channelType,
    });
    return { success: true, channelId: channel.id, channelName: channel.channel_name };
  }

  @Get('channels')
  @ApiOperation({ summary: 'List all storage channels (channel IDs are NOT exposed)' })
  async listChannels() {
    return this.channels.listChannels();
  }

  // ── MTProto Session ────────────────────────────────────────────────────────

  @Post('mtproto')
  @Roles('superadmin')
  @ApiOperation({
    summary: 'Register MTProto session for BotFather auto-provisioning',
    description: 'super_admin only. All credentials encrypted at rest with AES-256-GCM.',
  })
  async registerMtproto(@Body() dto: AdminSetMtprotoDto, @Req() req: any) {
    await this.provisioning.registerMtprotoSession({
      sessionName:   dto.sessionName,
      apiId:         dto.apiId,
      apiHash:       dto.apiHash,
      sessionString: dto.sessionString,
      phoneNumber:   dto.phoneNumber,
      actorId:       req.user.sub,
    });
    return { success: true, message: 'MTProto session registered and encrypted' };
  }

  // ── Health + Metrics ───────────────────────────────────────────────────────

  @Get('metrics')
  @ApiOperation({ summary: 'Storage pool metrics (bot counts, asset totals, dedup savings)' })
  async getMetrics() {
    const [poolMetrics, botHealth] = await Promise.all([
      this.orchestrator.getPoolMetrics(),
      this.health.getPoolHealth(),
    ]);
    return { pool: poolMetrics, bots: botHealth };
  }

  @Post('health-check')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger immediate bot pool health check (async)' })
  async triggerHealthCheck() {
    // Fire-and-forget
    this.pool.runHealthChecks().catch(() => {});
    return { success: true, message: 'Health check triggered' };
  }
}
