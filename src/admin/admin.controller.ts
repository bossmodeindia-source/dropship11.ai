/**
 * AdminController — Unified Admin + SuperAdmin Control Plane (V64)
 *
 * Merges admin-v59.controller.ts (system ops) and admin-v60.controller.ts
 * (financial + withdrawal controls) into a single, clearly organised file.
 *
 * ROLE MATRIX
 * ──────────────────────────────────────────────────────────────────────────
 * Endpoint group                         admin   superadmin
 * ──────────────────────────────────────────────────────────────────────────
 * User management (list/update/suspend)    ✓         ✓
 * User deletion (hard-delete)              -         ✓  superadmin only
 * Subscription overrides                   ✓         ✓
 * Finance snapshot / commission config     -         ✓  superadmin only
 * Withdrawal (approve / reject)            ✓         ✓
 * Withdrawal (complete / freeze)           -         ✓  superadmin only
 * System mode / maintenance                -         ✓  superadmin only
 * Ads / organic global pause/resume        -         ✓  superadmin only
 * Queue management                         -         ✓  superadmin only
 * DLQ replay / discard                     -         ✓  superadmin only
 * Fail-safe controls                       -         ✓  superadmin only
 * Campaign recovery                        -         ✓  superadmin only
 * Tenant plan override / spend cap         -         ✓  superadmin only
 * Audit log query                          ✓         ✓
 * ──────────────────────────────────────────────────────────────────────────
 *
 * SECURITY
 *   • JwtAuthGuard + RolesGuard applied at class level — no bypass possible.
 *   • @SkipTenantGuard() on class — admin routes are cross-tenant by design.
 *   • Every write operation carries @AuditLog for immutable trail.
 *   • Commission rate is validated server-side (0 – 0.5); never exposed to
 *     tenant users.
 */

import {
  Controller, Get, Post, Delete, Patch,
  Param, Body, Query, UseGuards,
  HttpCode, HttpStatus, Logger,
  ParseUUIDPipe, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  IsString, IsOptional, IsNumber, IsEnum, IsPositive,
  Min, Max, IsDefined,
} from 'class-validator';
import { Type } from 'class-transformer';

import { JwtAuthGuard, RolesGuard }    from '../common/guards';
import { Roles }                        from '../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload }      from '../common/decorators/current-user.decorator';
import { AuditLog }                     from '../audit/audit-log.decorator';
import { AuditService, AuditSeverity }  from '../audit/audit.service';
import { SkipTenantGuard }              from '../tenant/tenant.guard';
import { SystemModeService, SystemMode } from '../system-mode/system-mode.service';
import { FailSafeService }              from '../failsafe/failsafe.service';
import { QueueManagerService }     from '../queue/queue.module';
import { RecoveryService }              from '../recovery/recovery.service';
import { CostProtectionService }        from '../cost-protection/cost-protection.service';
import { RealtimeGateway }              from '../realtime/realtime.gateway';
import { ObservabilityService }         from '../observability/observability.service';
import { AdminUsersService }            from './admin-users.service';
import { UnifiedFinanceEngine }         from '../finance/unified-finance-engine.service';
import { CommissionService }            from '../commission/commission.service';
import { WithdrawalService }            from '../withdrawal/withdrawal.service';
import { UpdateUserDto }                from './dto/update-user.dto';
import { UpdateSubscriptionDto }        from './dto/update-subscription.dto';

// ── Request DTOs ─────────────────────────────────────────────────────────────

class SetModeDto {
  @IsEnum(['normal', 'degraded', 'safe', 'maintenance'])
  mode!: SystemMode;

  @IsString()
  reason!: string;
}

class ReasonDto {
  @IsString()
  reason!: string;
}

class MaintenanceDto {
  @IsString()
  message!: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  estimatedMinutes?: number;
}

class SetSpendCapDto {
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  capUsd!: number;
}

class SetPlanDto {
  @IsEnum(['free', 'pro', 'elite'])
  plan!: string;
}

class CommissionDto {
  @IsDefined()
  @IsString()
  tenantId!: string;

  @IsNumber()
  @Min(0)
  @Max(0.5)
  @Type(() => Number)
  commissionRate!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minimumFlat?: number;
}

class WithdrawalActionDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

class WithdrawalRejectDto {
  @IsString()
  reason!: string;
}

class WithdrawalCompleteDto {
  @IsString()
  transactionRef!: string;
}

class WithdrawalFreezeDto {
  @IsString()
  reason!: string;
}

class AuditQueryDto {
  @IsOptional() @IsString()                                          tenantId?: string;
  @IsOptional() @IsString()                                          actorId?: string;
  @IsOptional() @IsString()                                          action?: string;
  @IsOptional() @IsString()                                          resource?: string;
  @IsOptional() @IsEnum(['info', 'warn', 'critical'])                severity?: AuditSeverity;
  @IsOptional() @IsNumber() @Min(1) @Max(500) @Type(() => Number)    limit?: number;
  @IsOptional() @IsNumber() @Min(0)           @Type(() => Number)    offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)   // Explicit guards — no bypass via APP_GUARD misconfiguration
@SkipTenantGuard()                     // Admin routes are intentionally cross-tenant
@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    // System & infrastructure
    private readonly systemMode:    SystemModeService,
    private readonly failSafe:      FailSafeService,
    private readonly queues:        QueueManagerService,
    private readonly recovery:      RecoveryService,
    private readonly costProtection:CostProtectionService,
    private readonly realtime:      RealtimeGateway,
    private readonly obs:           ObservabilityService,
    // Business
    private readonly adminUsers:    AdminUsersService,
    private readonly finance:       UnifiedFinanceEngine,
    private readonly commission:    CommissionService,
    private readonly withdrawal:    WithdrawalService,
    // Cross-cutting
    private readonly audit:         AuditService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // SYSTEM STATUS  [admin+]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('status')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Full system health overview' })
  async getStatus() {
    const [queueDepths, deps] = await Promise.all([
      this.queues.getQueueDepths(),
      this.failSafe.getStatus(),
    ]);
    return {
      systemMode:    this.systemMode.getState(),
      dependencies:  deps,
      queues:        queueDepths,
      wsConnections: this.realtime.getConnectedCount(),
      healthy:       this.failSafe.isHealthy(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SYSTEM MODE  [superadmin only]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('system/mode')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Get current system mode' })
  async getSystemMode() {
    return { mode: await this.systemMode.getCurrentMode() };
  }

  @Post('mode')
  @Roles('superadmin')
  @AuditLog('admin.set_mode')
  @ApiOperation({ summary: 'Change system mode (superadmin only)' })
  async setMode(@CurrentUser() actor: JwtPayload, @Body() dto: SetModeDto) {
    await this.systemMode.setMode(dto.mode, dto.reason, actor.sub);
    this.realtime.emitSystemMode(dto.mode, dto.reason);
    this.audit.logAdminAction(actor.sub, 'SET_MODE', 'system', dto.mode, { reason: dto.reason });
    return { mode: dto.mode, reason: dto.reason };
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  @Post('maintenance')
  @Roles('superadmin')
  @AuditLog('admin.enable_maintenance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable maintenance mode (superadmin only)' })
  async enableMaintenance(@CurrentUser() actor: JwtPayload, @Body() dto: MaintenanceDto) {
    this.logger.warn(`MAINTENANCE MODE ENABLED by ${actor.sub}: ${dto.message}`);
    await this.systemMode.enableMaintenance(actor.sub, dto.message);
    this.realtime.emitSystemMode('maintenance', dto.message);
    return { maintenance: true };
  }

  @Delete('maintenance')
  @Roles('superadmin')
  @AuditLog('admin.disable_maintenance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable maintenance mode (superadmin only)' })
  async disableMaintenance(@CurrentUser() actor: JwtPayload) {
    this.logger.warn(`MAINTENANCE MODE DISABLED by ${actor.sub}`);
    await this.systemMode.disableMaintenance(actor.sub);
    this.realtime.emitSystemMode('normal', 'Maintenance ended');
    return { maintenance: false };
  }

  // ── Ads / organic global controls ─────────────────────────────────────────

  @Post('ads/pause')
  @Roles('superadmin')
  @AuditLog('admin.pause_ads')
  @ApiOperation({ summary: 'Globally pause all paid ads (superadmin only)' })
  async pauseAds(@CurrentUser() actor: JwtPayload, @Body() dto: ReasonDto) {
    await this.systemMode.pauseGlobalAds(actor.sub, dto.reason);
    this.audit.logAdminAction(actor.sub, 'PAUSE_ADS', 'system', 'global', { reason: dto.reason });
    return { adsEnabled: false };
  }

  @Post('ads/resume')
  @Roles('superadmin')
  @AuditLog('admin.resume_ads')
  @ApiOperation({ summary: 'Globally resume all paid ads (superadmin only)' })
  async resumeAds(@CurrentUser() actor: JwtPayload) {
    await this.systemMode.resumeGlobalAds(actor.sub);
    this.audit.logAdminAction(actor.sub, 'RESUME_ADS', 'system', 'global');
    return { adsEnabled: true };
  }

  @Post('organic/pause')
  @Roles('superadmin')
  @AuditLog('admin.pause_organic')
  @ApiOperation({ summary: 'Globally pause organic growth (superadmin only)' })
  async pauseOrganic(@CurrentUser() actor: JwtPayload, @Body() dto: ReasonDto) {
    await this.systemMode.pauseGlobalOrganic(actor.sub, dto.reason);
    this.audit.logAdminAction(actor.sub, 'PAUSE_ORGANIC', 'system', 'global');
    return { organicEnabled: false };
  }

  @Post('organic/resume')
  @Roles('superadmin')
  @AuditLog('admin.resume_organic')
  @ApiOperation({ summary: 'Globally resume organic growth (superadmin only)' })
  async resumeOrganic(@CurrentUser() actor: JwtPayload) {
    await this.systemMode.resumeGlobalOrganic(actor.sub);
    this.audit.logAdminAction(actor.sub, 'RESUME_ORGANIC', 'system', 'global');
    return { organicEnabled: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // USER MANAGEMENT  [admin+]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('users')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'List all users (paginated, optional search)' })
  async listUsers(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @CurrentUser() actor?: JwtPayload,
  ) {
    this.logger.log(`Admin list users: actor=${actor?.sub}`);
    return this.adminUsers.findAll(page, Math.min(limit, 200), search);
  }

  @Patch('users/:id')
  @Roles('admin', 'superadmin')
  @AuditLog('admin.update_user')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update user profile / role / status (admin+)' })
  async updateUser(
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    this.logger.warn(`Admin update user: target=${userId} actor=${actor.sub}`);
    return this.adminUsers.updateUser(userId, dto, actor.sub);
  }

  @Delete('users/:id')
  @Roles('superadmin')
  @AuditLog('admin.delete_user')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Hard-delete a user (superadmin only — cascades via FK)' })
  async deleteUser(
    @Param('id', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    this.logger.warn(`Admin HARD-DELETE user: target=${userId} actor=${actor.sub}`);
    return this.adminUsers.deleteUser(userId, actor.sub);
  }

  @Post('users/:id/suspend')
  @Roles('admin', 'superadmin')
  @AuditLog('admin.suspend_user')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a user account (admin+)' })
  async suspendUser(
    @Param('id', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.adminUsers.suspendUser(actor.sub, userId);
  }

  @Post('users/:id/reactivate')
  @Roles('admin', 'superadmin')
  @AuditLog('admin.reactivate_user')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended user account (admin+)' })
  async reactivateUser(
    @Param('id', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.adminUsers.reactivateUser(actor.sub, userId);
  }

  @Post('users/:id/freeze')
  @Roles('superadmin')
  @AuditLog('admin.freeze_user')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Freeze a user account (superadmin only)' })
  async freezeUser(
    @Param('id') userId: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    await this.systemMode.freezeUser(actor.sub, userId, dto.reason);
    this.audit.logAdminAction(actor.sub, 'FREEZE_USER', 'users', userId, { reason: dto.reason });
    return { frozen: true };
  }

  @Post('users/:id/unfreeze')
  @Roles('superadmin')
  @AuditLog('admin.unfreeze_user')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unfreeze a user account (superadmin only)' })
  async unfreezeUser(
    @Param('id') userId: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    await this.systemMode.unfreezeUser(actor.sub, userId);
    this.audit.logAdminAction(actor.sub, 'UNFREEZE_USER', 'users', userId);
    return { frozen: false };
  }

  @Patch('users/:id/subscription')
  @Roles('admin', 'superadmin')
  @AuditLog('admin.update_subscription')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update user subscription plan / limits (admin+)' })
  async updateSubscription(
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSubscriptionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.adminUsers.updateSubscription(userId, dto, actor.sub);
  }

  @Get('users/:id/audit-log')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Get audit log entries for a specific user (admin+)' })
  getUserAuditLog(
    @Param('id', ParseUUIDPipe) userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.adminUsers.getUserAuditLog(userId, page, Math.min(limit, 100));
  }

  @Get('users/stats')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Platform-wide user statistics (admin+)' })
  getUserStats() {
    return this.adminUsers.getStats();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUPPLIER MANAGEMENT  [superadmin only]
  // ══════════════════════════════════════════════════════════════════════════

  @Post('suppliers/:id/freeze')
  @Roles('superadmin')
  @AuditLog('admin.freeze_supplier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Freeze a supplier (superadmin only)' })
  async freezeSupplier(
    @Param('id') supplierId: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    await this.systemMode.freezeSupplier(actor.sub, supplierId, dto.reason);
    this.audit.logAdminAction(actor.sub, 'FREEZE_SUPPLIER', 'suppliers', supplierId);
    return { frozen: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // QUEUE MANAGEMENT  [superadmin only]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('queues')
  @Roles('superadmin')
  @ApiOperation({ summary: 'Queue depths across all workers (superadmin only)' })
  async getQueues() {
    return this.queues.getQueueDepths();
  }

  @Post('queues/pause')
  @Roles('superadmin')
  @AuditLog('admin.pause_queues')
  @ApiOperation({ summary: 'Pause all queues (superadmin only)' })
  async pauseQueues(@CurrentUser() actor: JwtPayload) {
    await this.queues.pauseAll();
    this.audit.logAdminAction(actor.sub, 'PAUSE_QUEUES', 'queues', 'all');
    return { paused: true };
  }

  @Post('queues/resume')
  @Roles('superadmin')
  @AuditLog('admin.resume_queues')
  @ApiOperation({ summary: 'Resume all queues (superadmin only)' })
  async resumeQueues(@CurrentUser() actor: JwtPayload) {
    await this.queues.resumeAll();
    this.audit.logAdminAction(actor.sub, 'RESUME_QUEUES', 'queues', 'all');
    return { paused: false };
  }

  @Get('queues/dlq')
  @Roles('superadmin')
  @ApiOperation({ summary: 'List dead-letter-queue jobs (superadmin only)' })
  async getDlq(@Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    return this.recovery.getDlqJobs(Math.min(limit, 200));
  }

  @Post('queues/dlq/:id/replay')
  @Roles('superadmin')
  @AuditLog('admin.replay_dlq_job')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replay a DLQ job (superadmin only)' })
  async replayDlqJob(@Param('id') jobId: string, @CurrentUser() actor: JwtPayload) {
    await this.recovery.replayDlqJob(jobId, actor.sub);
    this.audit.logAdminAction(actor.sub, 'REPLAY_DLQ_JOB', 'dlq', jobId);
    return { replayed: true };
  }

  @Delete('queues/dlq/:id')
  @Roles('superadmin')
  @AuditLog('admin.discard_dlq_job')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Discard a DLQ job permanently (superadmin only)' })
  async discardDlqJob(@Param('id') jobId: string) {
    await this.recovery.clearDlqJob(jobId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FAIL-SAFE CONTROLS  [superadmin only]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('failsafe')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Fail-safe dependency health (admin+)' })
  getFailsafe() {
    return {
      dependencies: this.failSafe.getStatus(),
      healthy:      this.failSafe.isHealthy(),
    };
  }

  @Post('failsafe/pause')
  @Roles('superadmin')
  @AuditLog('admin.force_pause_execution')
  @ApiOperation({ summary: 'Force-pause all execution via fail-safe (superadmin only)' })
  async forceExecPause(@CurrentUser() actor: JwtPayload, @Body() dto: ReasonDto) {
    await this.failSafe.forceExecutionPause(dto.reason);
    this.audit.logAdminAction(actor.sub, 'FORCE_PAUSE_EXECUTION', 'system', 'all');
    return { paused: true };
  }

  @Post('failsafe/resume')
  @Roles('superadmin')
  @AuditLog('admin.force_resume_execution')
  @ApiOperation({ summary: 'Force-resume execution via fail-safe (superadmin only)' })
  async forceExecResume(@CurrentUser() actor: JwtPayload) {
    await this.failSafe.forceExecutionResume();
    this.audit.logAdminAction(actor.sub, 'FORCE_RESUME_EXECUTION', 'system', 'all');
    return { paused: false };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RECOVERY  [superadmin only]
  // ══════════════════════════════════════════════════════════════════════════

  @Post('recovery/campaigns')
  @Roles('superadmin')
  @AuditLog('admin.recover_campaigns')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recover stuck campaigns (superadmin only)' })
  async recoverCampaigns(@CurrentUser() actor: JwtPayload) {
    const result = await this.recovery.recoverStuckCampaigns();
    this.audit.logAdminAction(actor.sub, 'RECOVER_CAMPAIGNS', 'campaigns', 'stuck', result);
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TENANT MANAGEMENT  [superadmin only]
  // ══════════════════════════════════════════════════════════════════════════

  @Patch('tenants/:id/plan')
  @Roles('superadmin')
  @AuditLog('admin.override_plan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Override a tenant plan (superadmin only)' })
  async overridePlan(
    @Param('id') tenantId: string,
    @Body() dto: SetPlanDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    this.audit.logAdminAction(actor.sub, 'OVERRIDE_PLAN', 'tenants', tenantId, { plan: dto.plan });
    return { tenantId, plan: dto.plan };
  }

  @Post('tenants/:id/spend-cap')
  @Roles('superadmin')
  @AuditLog('admin.set_spend_cap')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set custom daily spend cap for a tenant (superadmin only)' })
  async setSpendCap(
    @Param('id') tenantId: string,
    @Body() dto: SetSpendCapDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    await this.costProtection.setCustomDailyCap(tenantId, dto.capUsd);
    this.audit.logAdminAction(actor.sub, 'SET_SPEND_CAP', 'tenants', tenantId, { capUsd: dto.capUsd });
    return { tenantId, dailyCapUsd: dto.capUsd };
  }

  @Post('tenants/:id/unblock-spend')
  @Roles('superadmin')
  @AuditLog('admin.unblock_spend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a spend block for a tenant (superadmin only)' })
  async unblockSpend(
    @Param('id') tenantId: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    await this.costProtection.unblockSpend(tenantId, actor.sub);
    this.audit.logAdminAction(actor.sub, 'UNBLOCK_SPEND', 'tenants', tenantId);
    return { unblocked: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FINANCIAL CONTROLS  [superadmin only]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('finance/snapshot')
  @Roles('superadmin')
  @ApiOperation({ summary: 'Platform-wide finance snapshot including commission (superadmin only)' })
  async getPlatformFinanceSnapshot(
    @Query('tenantId') tenantId: string,
    @Query('botId') botId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.finance.computeProfitSnapshot(
      tenantId, botId,
      new Date(from),
      new Date(to),
    );
  }

  @Post('commission/configure')
  @Roles('superadmin')
  @AuditLog('admin.configure_commission')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set commission rate for a tenant (superadmin only)' })
  async setCommissionRate(
    @Body() dto: CommissionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    // SECURITY: Commission rates are validated server-side and NEVER exposed to tenant users.
    this.logger.warn(
      `Commission update: tenant=${dto.tenantId} rate=${dto.commissionRate} actor=${actor.sub}`,
    );
    return this.commission.setCommissionRate(dto.tenantId, dto.commissionRate, actor.sub);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WITHDRAWAL MANAGEMENT  [admin+ / superadmin for escalated actions]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('withdrawals/pending')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'List pending withdrawals (admin+)' })
  async listPendingWithdrawals(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.withdrawal.listPending({ page, limit });
  }

  @Post('withdrawals/:id/approve')
  @Roles('admin', 'superadmin')
  @AuditLog('admin.approve_withdrawal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending withdrawal (admin+)' })
  async approveWithdrawal(
    @Param('id') withdrawalId: string,
    @Body() dto: WithdrawalActionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.withdrawal.approve(withdrawalId, actor.sub, dto.notes);
  }

  @Post('withdrawals/:id/reject')
  @Roles('admin', 'superadmin')
  @AuditLog('admin.reject_withdrawal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a withdrawal (admin+)' })
  async rejectWithdrawal(
    @Param('id') withdrawalId: string,
    @Body() dto: WithdrawalRejectDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.withdrawal.reject(withdrawalId, actor.sub, dto.reason);
  }

  @Post('withdrawals/:id/complete')
  @Roles('superadmin')
  @AuditLog('admin.complete_withdrawal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a withdrawal as completed (superadmin only)' })
  async completeWithdrawal(
    @Param('id') withdrawalId: string,
    @Body() dto: WithdrawalCompleteDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.withdrawal.complete(withdrawalId, actor.sub, dto.transactionRef);
  }

  @Post('withdrawals/:userId/freeze')
  @Roles('superadmin')
  @AuditLog('admin.freeze_withdrawals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Freeze all withdrawals for a user (superadmin only)' })
  async freezeWithdrawals(
    @Param('userId') userId: string,
    @Body() dto: WithdrawalFreezeDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.withdrawal.freezeUser(userId, actor.sub, dto.reason);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUDIT TRAIL  [admin+]
  // ══════════════════════════════════════════════════════════════════════════

  @Get('audit')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Query immutable audit trail (admin+)' })
  @ApiResponse({ status: 200, description: 'Filtered audit log entries, newest first.' })
  async getAuditLogs(
    @Query() query: AuditQueryDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    this.logger.log(`Audit query: actor=${actor.sub} filters=${JSON.stringify(query)}`);
    return this.audit.query(query);
  }
}
