/**
 * UserAiConnectionsController
 *
 * User-facing endpoints for managing their AI provider connections.
 * All endpoints require JWT + tenant context.
 * Encrypted keys are NEVER returned in any response.
 */

import {
  Controller, Get, Post, Delete,
  Param, Body, UseGuards, Request,
  ParseUUIDPipe, HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { UserAiConnectionsService } from './user-ai-connections.service';
import { ConnectProviderDto, SetAiProviderPreferenceDto } from './dto/user-ai-connections.dto';
import { JwtAuthGuard } from '../common/guards';

@Controller('api/v1/user/ai-connections')
@UseGuards(JwtAuthGuard)
export class UserAiConnectionsController {
  constructor(private readonly service: UserAiConnectionsService) {}

  /** List user's current AI provider connections (no keys exposed) */
  @Get()
  async listConnections(@Request() req: any) {
    return this.service.listConnections(req.user.tenantId);
  }

  /**
   * Connect user's own API key to an admin-approved provider.
   * Key is validated then AES-256 encrypted before storage.
   * The plaintext key is NEVER stored.
   */
  @Post('connect')
  async connectProvider(
    @Body() dto: ConnectProviderDto,
    @Request() req: any,
  ) {
    const connection = await this.service.connectProvider(req.user.tenantId, dto);
    return {
      message: `Provider connected successfully`,
      connection,
    };
  }

  /** Disconnect (soft-delete) a provider connection */
  @Delete(':connectionId')
  @HttpCode(HttpStatus.OK)
  async disconnectProvider(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Request() req: any,
  ) {
    await this.service.disconnectProvider(req.user.tenantId, connectionId);
    return { message: 'Provider disconnected' };
  }

  /** Run health check on a specific connection */
  @Post(':connectionId/health-check')
  @HttpCode(HttpStatus.OK)
  async healthCheck(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Request() req: any,
  ) {
    return this.service.healthCheckConnection(req.user.tenantId, connectionId);
  }

  /** Get usage analytics for this tenant's AI usage */
  @Get('analytics')
  async getAnalytics(
    @Request() req: any,
    @Query('days') days?: string,
  ) {
    return this.service.getUsageAnalytics(req.user.tenantId, days ? parseInt(days) : 30);
  }

  @Get('preferences')
  async getPreferences(@Request() req: any) {
    return this.service.getProviderPreferences(req.user.tenantId);
  }

  @Post('preferences')
  @HttpCode(HttpStatus.OK)
  async setPreference(
    @Body() dto: SetAiProviderPreferenceDto,
    @Request() req: any,
  ) {
    return this.service.setProviderPreference(req.user.tenantId, dto);
  }
}
