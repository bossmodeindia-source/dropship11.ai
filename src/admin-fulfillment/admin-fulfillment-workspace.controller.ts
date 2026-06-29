/**
 * AdminFulfillmentWorkspaceController
 *
 * Admin-only REST API for the supplier payment + fulfillment dashboard.
 *
 * Routes (all require ADMIN role):
 *   GET  /admin/fulfillment/pending           — list tasks awaiting supplier payment
 *   GET  /admin/fulfillment/:id               — task detail with financial breakdown
 *   POST /admin/fulfillment/:id/checkout      — build supplier checkout session (autofill)
 *   POST /admin/fulfillment/:id/mark-paid     — confirm supplier paid + upload proof
 *   POST /admin/fulfillment/:id/tracking      — sync tracking number
 *   POST /admin/fulfillment/:id/retry         — retry failed fulfillment
 *   GET  /admin/fulfillment/financial-summary — P&L summary for date range
 *   GET  /admin/escrow/pending                — list escrows awaiting supplier payment
 */

import {
  Controller, Get, Post, Body, Param, Query, Req, UseGuards,
  Logger, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common';

import { Roles }         from '../common/decorators/roles.decorator';
import { JwtAuthGuard }  from '../common/guards';
import { RolesGuard }    from '../common/guards';
import { SupplierFulfillmentService } from '../supplier-fulfillment/supplier-fulfillment.service';
import { SupplierCheckoutAutomationService } from '../supplier-fulfillment/supplier-checkout-automation.service';
import { EscrowTransactionService } from '../escrow/escrow-transaction.service';
import { AuditService }  from '../audit/audit.service';

class MarkPaidDto {
  supplierOrderId?: string;
  paymentProofUrl?: string;
}

class SyncTrackingDto {
  trackingNumber!: string;
  trackingCarrier!: string;
  trackingUrl?:    string;
}

class FinancialSummaryQueryDto {
  from!: string;  // ISO date string
  to!:   string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
@Controller('admin/fulfillment')
export class AdminFulfillmentWorkspaceController {
  private readonly logger = new Logger(AdminFulfillmentWorkspaceController.name);

  constructor(
    private readonly fulfillment: SupplierFulfillmentService,
    private readonly checkout:    SupplierCheckoutAutomationService,
    private readonly escrow:      EscrowTransactionService,
    private readonly audit:       AuditService,
  ) {}

  // ── Pending fulfillment tasks ──────────────────────────────────────────────

  @Get('pending')
  async listPending(
    @Query('supplier') supplier?: string,
    @Query('limit')    limit    = 100,
  ) {
    return this.fulfillment.listPendingForAdmin(supplier as any, +limit);
  }

  // ── Pending escrows (payment verified but not yet supplier-paid) ───────────

  @Get('escrow/pending')
  async listPendingEscrows() {
    return this.escrow.listPendingSupplierPayments();
  }

  // ── Open supplier checkout session (with autofill) ─────────────────────────

  @Post(':id/checkout')
  @HttpCode(HttpStatus.OK)
  async openCheckout(@Param('id') id: string, @Req() req: Request) {
    const adminId = (req as any).user?.id ?? 'system';
    return this.checkout.buildCheckoutSession(id, adminId);
  }

  // ── Mark supplier paid ─────────────────────────────────────────────────────

  @Post(':id/mark-paid')
  @HttpCode(HttpStatus.OK)
  async markPaid(
    @Param('id') id: string,
    @Body() dto: MarkPaidDto,
    @Req() req: Request,
  ) {
    const adminId = (req as any).user?.id ?? 'system';
    await this.fulfillment.markSupplierPaid(id, adminId, dto.paymentProofUrl, dto.supplierOrderId);
    return { success: true };
  }

  // ── Sync tracking number ───────────────────────────────────────────────────

  @Post(':id/tracking')
  @HttpCode(HttpStatus.OK)
  async syncTracking(
    @Param('id') id: string,
    @Body() dto: SyncTrackingDto,
    @Req() req: Request,
  ) {
    if (!dto.trackingNumber || !dto.trackingCarrier) {
      throw new BadRequestException('trackingNumber and trackingCarrier are required');
    }
    const adminId = (req as any).user?.id ?? 'system';
    await this.fulfillment.syncTracking(
      id, adminId, dto.trackingNumber, dto.trackingCarrier, dto.trackingUrl,
    );
    return { success: true };
  }

  // ── Financial summary ──────────────────────────────────────────────────────

  @Get('financial-summary')
  async financialSummary(@Query() q: FinancialSummaryQueryDto) {
    if (!q.from || !q.to) throw new BadRequestException('from and to date params required');
    return this.escrow.getAdminFinancialSummary(new Date(q.from), new Date(q.to));
  }
}
