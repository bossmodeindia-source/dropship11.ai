/**
 * WithdrawalController
 *
 * User Routes (JWT required, own data only):
 *   POST  /withdrawals/request          — Submit withdrawal request
 *   GET   /withdrawals/history          — View own withdrawal history
 *
 * Admin Routes (admin/super_admin role required):
 *   GET   /admin/withdrawals            — List all withdrawals (filterable by status)
 *   GET   /admin/withdrawals/:id/bank-details  — Decrypt bank details (audit-logged)
 *   POST  /admin/withdrawals/:id/approve       — Approve a pending withdrawal
 *   POST  /admin/withdrawals/:id/reject        — Reject with mandatory notes
 *   POST  /admin/withdrawals/:id/complete      — Mark as paid (with optional Razorpay ID)
 *   POST  /admin/withdrawals/:id/freeze        — Freeze suspicious withdrawal
 *
 * Security:
 *   - Users can ONLY see their own withdrawals (enforced by service)
 *   - Admin bank-detail decrypt is separately RBAC-gated and fully audit-logged
 *   - Rate limiting via @Throttle applied to user submission endpoint
 *   - tenantId injected from JWT context — never from request body
 */

import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantId } from '../tenant/tenant.guard';
import { WithdrawalService } from './withdrawal.service';
import { WithdrawalFraudService } from './withdrawal-fraud.service';
import {
  RequestWithdrawalDto,
  ApproveWithdrawalDto,
  RejectWithdrawalDto,
  CompleteWithdrawalDto,
  FreezeWithdrawalDto,
} from './dto/withdrawal.dto';

// ── User Routes ───────────────────────────────────────────────────────────────

@ApiTags('Withdrawals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('withdrawals')
export class WithdrawalController {
  constructor(private readonly withdrawalService: WithdrawalService) {}

  @Post('request')
  @Roles('user', 'admin', 'superadmin')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 3600 } })   // max 5 requests per hour
  @ApiOperation({ summary: 'Request a manual withdrawal (bank transfer)' })
  async requestWithdrawal(
    @Request() req: any,
    @TenantId() tenantId: string,
    @Body() dto: RequestWithdrawalDto,
  ) {
    const userId    = req.user.id as string;
    const ipAddress = req.ip as string;

    return this.withdrawalService.requestWithdrawal(userId, tenantId, dto, ipAddress);
  }

  @Get('history')
  @Roles('user', 'admin', 'superadmin')
  @ApiOperation({ summary: 'View own withdrawal history' })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getHistory(
    @Request() req: any,
    @TenantId() tenantId: string,
    @Query('limit',  new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0),  ParseIntPipe) offset: number,
  ) {
    const userId = req.user.id as string;
    return this.withdrawalService.getUserWithdrawals(userId, tenantId, limit, offset);
  }
}

// ── Admin Routes ──────────────────────────────────────────────────────────────

@ApiTags('Admin — Withdrawals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/withdrawals')
export class AdminWithdrawalController {
  constructor(
    private readonly withdrawalService: WithdrawalService,
    private readonly fraudService: WithdrawalFraudService,
  ) {}

  @Get()
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'List all withdrawal requests (admin)' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'rejected', 'completed'] })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async listAll(
    @Query('status') status?: string,
    @Query('limit',  new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0),  ParseIntPipe) offset?: number,
  ) {
    return this.withdrawalService.adminListWithdrawals(status, limit, offset);
  }

  @Get(':id/bank-details')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Decrypt bank details for payout (critical audit event)' })
  @ApiParam({ name: 'id', description: 'Withdrawal UUID' })
  async getBankDetails(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    const adminId   = req.user.id as string;
    const ipAddress = req.ip as string;
    return this.withdrawalService.adminDecryptBankDetails(id, adminId, ipAddress);
  }

  @Post(':id/approve')
  @Roles('admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending withdrawal request' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
    @Body() dto: ApproveWithdrawalDto,
  ) {
    const adminId   = req.user.id as string;
    const ipAddress = req.ip as string;
    return this.withdrawalService.adminApprove(id, adminId, dto, ipAddress);
  }

  @Post(':id/reject')
  @Roles('admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a withdrawal with mandatory reason' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
    @Body() dto: RejectWithdrawalDto,
  ) {
    const adminId   = req.user.id as string;
    const ipAddress = req.ip as string;
    return this.withdrawalService.adminReject(id, adminId, dto, ipAddress);
  }

  @Post(':id/complete')
  @Roles('admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an approved withdrawal as paid (payout complete)' })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
    @Body() dto: CompleteWithdrawalDto,
  ) {
    const adminId   = req.user.id as string;
    const ipAddress = req.ip as string;
    return this.withdrawalService.adminComplete(id, adminId, dto, ipAddress);
  }

  @Post(':id/freeze')
  @Roles('admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Freeze a suspicious withdrawal request' })
  async freeze(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
    @Body() dto: FreezeWithdrawalDto,
  ) {
    const adminId   = req.user.id as string;
    const ipAddress = req.ip as string;
    return this.withdrawalService.adminFreeze(id, adminId, dto, ipAddress);
  }

  @Post('users/:userId/freeze-all')
  @Roles('superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Freeze ALL pending withdrawals for a user (super_admin only)' })
  async freezeUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @TenantId() tenantId: string,
    @Request() req: any,
    @Body() dto: FreezeWithdrawalDto,
  ) {
    const adminId   = req.user.id as string;
    const ipAddress = req.ip as string;
    const count = await this.fraudService.freezeUserWithdrawals(
      userId, tenantId, dto.reason, adminId,
    );
    return { frozen: count, message: `${count} pending withdrawal(s) frozen for user ${userId}` };
  }
}
