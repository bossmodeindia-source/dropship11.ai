// user-business-connections.controller.ts
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards, Request,
  ParseUUIDPipe, HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { UserBusinessConnectionsService } from './user-business-connections.service';
import {
  ConnectBusinessAccountDto,
  ConnectWebsitePlatformDto,
  CreateWebsitePlatformDto,
  UpdateWebsitePlatformDto,
} from './dto/user-business-connections.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin/website-platforms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminWebsitePlatformsController {
  constructor(private readonly service: UserBusinessConnectionsService) {}

  @Get()
  async list(@Query('includeDisabled') includeDisabled?: string) {
    return this.service.listWebsitePlatforms(includeDisabled !== 'false');
  }

  @Get('presets')
  async presets() {
    return this.service.getWebsitePlatformPresets();
  }

  @Get('analytics')
  async analytics(@Query('days') days?: string) {
    return this.service.getWebsitePlatformAnalytics(days ? parseInt(days, 10) : 30);
  }

  @Post()
  async create(@Body() dto: CreateWebsitePlatformDto, @Request() req: any) {
    return this.service.createWebsitePlatform(dto, req.user.id);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebsitePlatformDto,
    @Request() req: any,
  ) {
    return this.service.updateWebsitePlatform(id, dto, req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    await this.service.deleteWebsitePlatform(id, req.user.id);
    return { message: 'Website platform disabled/deleted', platformId: id };
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  async test(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.service.testWebsitePlatform(id, req.user.id);
  }
}

@Controller('api/v1/website-platforms')
@UseGuards(JwtAuthGuard)
export class WebsitePlatformsPublicController {
  constructor(private readonly service: UserBusinessConnectionsService) {}

  @Get('available')
  async available() {
    return this.service.listEnabledWebsitePlatforms();
  }
}

@Controller('api/v1/user/business-connections')
@UseGuards(JwtAuthGuard)
export class UserBusinessConnectionsController {
  constructor(private readonly service: UserBusinessConnectionsService) {}

  @Get()
  async list(@Request() req: any) {
    return this.service.listConnections(req.user.tenantId);
  }

  @Post('connect')
  async connect(
    @Body() dto: ConnectBusinessAccountDto,
    @Request() req: any,
  ) {
    const connection = await this.service.connectAccount(req.user.tenantId, dto);
    return { message: 'Account connected successfully', connection };
  }

  @Delete(':connectionId')
  @HttpCode(HttpStatus.OK)
  async disconnect(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Request() req: any,
  ) {
    await this.service.disconnectAccount(req.user.tenantId, connectionId);
    return { message: 'Account disconnected' };
  }

  @Get('website')
  async listWebsite(@Request() req: any) {
    return this.service.listUserPlatformConnections(req.user.tenantId);
  }

  @Post('website/connect')
  async connectWebsite(
    @Body() dto: ConnectWebsitePlatformDto,
    @Request() req: any,
  ) {
    const connection = await this.service.connectWebsitePlatform(req.user.tenantId, dto);
    return { message: 'Website platform connected successfully', connection };
  }
}
