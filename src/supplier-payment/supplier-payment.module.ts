/**
 * SupplierPaymentController + Module
 *
 * User Routes:
 *   GET  /supplier-payments           — List own supplier payment records
 *   POST /supplier-payments/:id/initiate — Signal payment initiation
 *
 * Admin Routes:
 *   GET  /admin/supplier-payments     — List all payments
 *   POST /admin/supplier-payments/:id/mark-paid — Confirm payment received
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  IsString,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiPropertyOptional } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantId } from '../tenant/tenant.guard';
import { SupplierPaymentService } from './supplier-payment.service';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class AdminMarkPaidDto {
  @ApiPropertyOptional({ description: 'Optional admin notes for the payment record' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ── User Controller ───────────────────────────────────────────────────────────

@ApiTags('Supplier Payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('supplier-payments')
export class SupplierPaymentController {
  constructor(private readonly supplierPayments: SupplierPaymentService) {}

  @Get()
  @Roles('user', 'admin', 'superadmin')
  @ApiOperation({ summary: 'List own supplier payment records (user-safe view — no internal costs)' })
  async list(@Request() req: any, @TenantId() tenantId: string) {
    return this.supplierPayments.getUserPayments(req.user.id, tenantId);
  }

  @Post(':id/initiate')
  @Roles('user', 'admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate supplier payment (signals admin to confirm)' })
  async initiate(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
    @TenantId() tenantId: string,
  ) {
    return this.supplierPayments.initiatePayment(id, req.user.id, tenantId);
  }
}

// ── Admin Controller ──────────────────────────────────────────────────────────

@ApiTags('Admin — Supplier Payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/supplier-payments')
export class AdminSupplierPaymentController {
  constructor(private readonly supplierPayments: SupplierPaymentService) {}

  @Post(':id/mark-paid')
  @Roles('admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm supplier payment received — advances order to supplier_paid status',
  })
  async markPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
    @Body() dto: AdminMarkPaidDto,
  ) {
    return this.supplierPayments.adminMarkPaid(id, req.user.id, dto.notes);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { CommissionModule } from '../commission/commission.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [DatabaseModule, CommissionModule, AuditModule],
  controllers: [SupplierPaymentController, AdminSupplierPaymentController],
  providers: [SupplierPaymentService],
  exports:  [SupplierPaymentService],
})
export class SupplierPaymentModule {}
