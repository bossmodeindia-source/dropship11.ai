import {
  Controller, Get, Query, Req, UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards';
import { CommerceAnalyticsService } from './commerce-analytics.service';

@UseGuards(JwtAuthGuard)
@Controller('api/v1/analytics')
export class CommerceAnalyticsController {
  constructor(private readonly analytics: CommerceAnalyticsService) {}

  @Get('dashboard')
  async dashboard(@Req() req: Request) {
    const tenantId = (req as any).tenantId;
    return this.analytics.getDashboardSummary(tenantId);
  }

  @Get('kpis/history')
  async kpiHistory(
    @Req() req: Request,
    @Query('period') period: 'hourly' | 'daily' | 'weekly' = 'daily',
    @Query('limit')  limit  = 30,
  ) {
    const tenantId = (req as any).tenantId;
    return this.analytics.getSnapshotHistory(tenantId, period, +limit);
  }

  @Get('kpis/live')
  async liveKpis(
    @Req() req: Request,
    @Query('lookbackHours') lookback = 24,
  ) {
    const tenantId = (req as any).tenantId;
    return this.analytics.computeLiveKpis(tenantId, 'daily', +lookback);
  }
}
