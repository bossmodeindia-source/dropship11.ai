/**
 * ProviderRequestController — User endpoints
 *
 * Authenticated users submit and track provider integration requests.
 * Admin review happens via ProviderRequestAdminController.
 */

import {
  Controller, Get, Post, Delete, Body, Param,
  ParseUUIDPipe, UseGuards, HttpCode, HttpStatus,
  Query, ParseIntPipe, DefaultValuePipe, Request,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards';
import { ProviderRequestService } from './provider-request.service';
import { SubmitProviderRequestDto } from './provider-request.dto';

@ApiTags('Provider Requests (User)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/user/provider-requests')
export class ProviderRequestController {
  constructor(private readonly svc: ProviderRequestService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a request for a new AI provider' })
  async submit(@Request() req: any, @Body() dto: SubmitProviderRequestDto) {
    return this.svc.submit(req.user.tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List my provider requests' })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async list(
    @Request() req: any,
    @Query('limit',  new DefaultValuePipe(20),  ParseIntPipe) limit:  number,
    @Query('offset', new DefaultValuePipe(0),   ParseIntPipe) offset: number,
  ) {
    return this.svc.listForTenant(req.user.tenantId, { limit, offset });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific provider request' })
  async getOne(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getForTenant(req.user.tenantId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending provider request' })
  async cancel(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.cancel(req.user.tenantId, id);
  }
}
