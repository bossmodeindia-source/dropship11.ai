/**
 * AiUsageAnalyticsController — Admin only
 *
 * Read-only analytics dashboard for AI usage across all tenants.
 * No user keys or admin provider keys are ever exposed.
 */

import {
  Controller, Get, UseGuards, Query,
  ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { AiUsageAnalyticsService } from './ai-usage-analytics.service';

@ApiTags('AI Usage Analytics (Admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
@Controller('admin/ai-usage-analytics')
export class AiUsageAnalyticsController {
  constructor(private readonly svc: AiUsageAnalyticsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Platform-wide AI usage summary' })
  @ApiQuery({ name: 'days', required: false, type: Number, example: 30 })
  async summary(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return this.svc.platformSummary(days);
  }

  @Get('tenants')
  @ApiOperation({ summary: 'Per-tenant AI usage breakdown' })
  @ApiQuery({ name: 'days',   required: false, type: Number })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async tenants(
    @Query('days',   new DefaultValuePipe(30), ParseIntPipe) days:   number,
    @Query('limit',  new DefaultValuePipe(50), ParseIntPipe) limit:  number,
    @Query('offset', new DefaultValuePipe(0),  ParseIntPipe) offset: number,
  ) {
    return this.svc.tenantBreakdown(days, limit, offset);
  }

  @Get('providers')
  @ApiOperation({ summary: 'Per-provider usage and success-rate breakdown' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async providers(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return this.svc.providerBreakdown(days);
  }

  @Get('trend')
  @ApiOperation({ summary: 'Daily usage trend (last N days)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async trend(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return this.svc.dailyTrend(days);
  }

  @Get('top-consumers')
  @ApiOperation({ summary: 'Top tenants by AI cost (quota monitoring)' })
  @ApiQuery({ name: 'days',  required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async topConsumers(
    @Query('days',  new DefaultValuePipe(7),  ParseIntPipe) days:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.svc.topConsumers(days, limit);
  }

  @Get('quota-violations')
  @ApiOperation({ summary: 'Tenants approaching or exceeding AI quota limits' })
  async quotaViolations() {
    return this.svc.quotaViolations();
  }
}
