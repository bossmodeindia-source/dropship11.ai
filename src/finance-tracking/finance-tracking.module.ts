/**
 * FinanceTrackingController
 *
 * User routes:
 *   GET /finance/dashboard  — Tenant-scoped P&L dashboard (no supplier/commission details)
 *
 * Admin routes:
 *   GET /admin/finance/dashboard/:tenantId — Full dashboard with costs + commissions
 *   GET /admin/finance/platform            — Platform-wide aggregates
 *   POST /admin/finance/snapshot/:tenantId — Trigger manual daily snapshot
 */

import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantId } from '../tenant/tenant.guard';
import { FinanceTrackingService } from './finance-tracking.service';

@ApiTags('Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('finance')
export class FinanceTrackingController {
  constructor(private readonly finance: FinanceTrackingService) {}

  @Get('dashboard')
  @Roles('user', 'admin', 'superadmin')
  @ApiOperation({ summary: 'Get own finance dashboard (revenue, profit, ad spend, payouts)' })
  async getDashboard(@TenantId() tenantId: string) {
    // Commission and supplier costs excluded from user-facing response
    return this.finance.getUserDashboard(tenantId);
  }
}

@ApiTags('Admin — Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/finance')
export class AdminFinanceTrackingController {
  constructor(private readonly finance: FinanceTrackingService) {}

  @Get('dashboard/:tenantId')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Full finance dashboard for a specific tenant (includes supplier costs + commissions)' })
  async getAdminDashboard(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.finance.getAdminDashboardForTenant(tenantId);
  }

  @Get('platform')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Platform-wide financial aggregates across all tenants' })
  async getPlatformSummary() {
    return this.finance.getPlatformWideSummary();
  }

  @Post('snapshot/:tenantId')
  @Roles('superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger daily finance snapshot for a tenant' })
  async triggerSnapshot(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    await this.finance.writeSnapshot(tenantId);
    return { message: `Finance snapshot written for tenant ${tenantId}` };
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { ScheduleModule } from '@nestjs/schedule';
import { FinanceSnapshotScheduler } from './finance-snapshot.scheduler';

@Module({
  imports: [DatabaseModule],
  controllers: [FinanceTrackingController, AdminFinanceTrackingController],
  providers: [FinanceTrackingService, FinanceSnapshotScheduler],
  exports: [FinanceTrackingService],
})
export class FinanceTrackingModule {}
