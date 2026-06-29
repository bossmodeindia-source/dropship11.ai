import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * GET /dashboard — owner control panel
   * Returns cached snapshot if < 1hr old, otherwise computes live.
   */
  @Get()
  getOwnerDashboard(@CurrentUser() user: { id: string }) {
    return this.dashboardService.getOwnerDashboard(user.id);
  }

  /**
   * POST /dashboard/refresh — force snapshot recomputation
   * Use when you need fresh numbers immediately.
   */
  @Post('refresh')
  async refresh(@CurrentUser() user: { id: string }) {
    await this.dashboardService.computeAndCacheSnapshot(user.id);
    return { refreshed: true, timestamp: new Date() };
  }
}
