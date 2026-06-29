/**
 * ProviderRequestAdminController — Admin endpoints
 *
 * Admin reviews, approves, and rejects provider integration requests.
 * Approval can auto-seed ai_provider_catalog when providerKey is supplied.
 */

import {
  Controller, Get, Post, Body, Param,
  ParseUUIDPipe, UseGuards, HttpCode, HttpStatus,
  Query, ParseIntPipe, DefaultValuePipe, Request,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { ProviderRequestService } from './provider-request.service';
import { ReviewProviderRequestDto } from './provider-request.dto';

@ApiTags('Provider Requests (Admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
@Controller('admin/provider-requests')
export class ProviderRequestAdminController {
  constructor(private readonly svc: ProviderRequestService) {}

  /** Aggregate counts per status — used by admin dashboard */
  @Get('stats')
  @ApiOperation({ summary: 'Provider request summary stats' })
  async stats() {
    return this.svc.adminStats();
  }

  @Get()
  @ApiOperation({ summary: 'List all provider requests' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending','under_review','approved','rejected'] })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async list(
    @Query('status')                                          status?: string,
    @Query('limit',  new DefaultValuePipe(50),  ParseIntPipe) limit:  number = 50,
    @Query('offset', new DefaultValuePipe(0),   ParseIntPipe) offset: number = 0,
  ) {
    return this.svc.adminList({ status, limit, offset });
  }

  /** Mark a pending request as under review (signals user a human is looking at it) */
  @Post(':id/start-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark request as under review' })
  async startReview(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.markUnderReview(req.user.id, id);
  }

  /**
   * Approve or reject a provider request.
   *
   * When approving, supply `providerKey` to auto-seed the provider into
   * ai_provider_catalog so users can immediately connect their own keys.
   *
   * Example approved payload:
   * { "decision": "approved", "adminNote": "Meets all criteria", "providerKey": "groq" }
   *
   * Example rejected payload:
   * { "decision": "rejected", "adminNote": "SDK unstable, revisit Q3" }
   */
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a provider request' })
  async review(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewProviderRequestDto,
  ) {
    return this.svc.review(req.user.id, id, dto);
  }
}
