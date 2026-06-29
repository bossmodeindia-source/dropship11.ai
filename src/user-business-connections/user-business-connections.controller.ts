// user-business-connections.controller.ts
import {
  Controller, Get, Post, Delete,
  Param, Body, UseGuards, Request,
  ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common';
import { UserBusinessConnectionsService } from './user-business-connections.service';
import { ConnectBusinessAccountDto } from './dto/user-business-connections.dto';
import { JwtAuthGuard } from '../common/guards';

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
}
