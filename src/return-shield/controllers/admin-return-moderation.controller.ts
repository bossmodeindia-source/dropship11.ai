/**
 * AdminReturnModerationController — V64
 * AdminReturnModerationWorkspace
 *
 * Full admin control panel for return moderation.
 * ALL financial actions require admin/superadmin RBAC.
 * ALL actions are immutably audited.
 *
 * Capabilities:
 *   - Return queue with customer/order/financial context
 *   - Approve / Reject / Freeze / Close returns
 *   - Request more info, add notes
 *   - Upload admin-only evidence (never visible to customer)
 *   - Trigger manual refund (superadmin + explicit confirmation)
 *   - Export audit logs for compliance
 *   - Re-run fraud analysis on demand
 */

import {
  Controller, Get, Post, Patch, Param, Body,
  Query, UseGuards, Req, HttpCode, HttpStatus,
  Logger, ParseUUIDPipe, Res,
  UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor }           from '@nestjs/platform-express';
import {
  ApiTags, ApiOperation, ApiResponse,
  ApiBearerAuth, ApiQuery,
} from '@nestjs/swagger';
import { Request, Response }          from 'express';
import { JwtAuthGuard }               from '../../common/guards/jwt-auth.guard';
import { RolesGuard }                 from '../../common/guards/roles.guard';
import { Roles }                      from '../../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload }    from '../../common/decorators/current-user.decorator';
import { TenantContext }              from '../../tenant/tenant.context';
import { ReturnRequestService }       from '../services/return-request.service';
import { ReturnEvidenceStorageService } from '../services/return-evidence-storage.service';
import { ReturnAuditService }         from '../services/return-audit.service';
import { ReturnFraudDetectionService } from '../services/return-fraud-detection.service';
import {
  AdminReturnQueryDto,
  AdminReturnActionDto,
  AdminManualRefundDto,
} from '../dto/return-shield.dto';

@ApiTags('Admin — Return Moderation Workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
@Controller('admin/returns')
export class AdminReturnModerationController {
  private readonly logger = new Logger(AdminReturnModerationController.name);

  constructor(
    private readonly returnService:   ReturnRequestService,
    private readonly evidenceService: ReturnEvidenceStorageService,
    private readonly auditService:    ReturnAuditService,
    private readonly fraudService:    ReturnFraudDetectionService,
  ) {}

  // ── GET /admin/returns ───────────────────────────────────────────────────
  // Return moderation queue with full context

  @Get()
  @ApiOperation({
    summary: 'Admin: Return moderation queue',
    description: 'All return requests with fraud scores, financial exposure, and fulfillment status.',
  })
  @ApiQuery({ name: 'status',       required: false })
  @ApiQuery({ name: 'tenantId',     required: false })
  @ApiQuery({ name: 'customerId',   required: false })
  @ApiQuery({ name: 'orderId',      required: false })
  @ApiQuery({ name: 'highRiskOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'page',         required: false, type: Number })
  @ApiQuery({ name: 'limit',        required: false, type: Number })
  async listReturns(@Query() query: AdminReturnQueryDto) {
    return this.returnService.adminListReturns(query);
  }

  // ── GET /admin/returns/stats ─────────────────────────────────────────────
  // Dashboard statistics: counts by status + risk + financial safety status

  @Get('stats')
  @ApiOperation({ summary: 'Admin: Return queue statistics overview' })
  async getStats() {
    const statuses = [
      'RETURN_REQUESTED', 'RETURN_PROCESSING', 'UNDER_ADMIN_REVIEW',
      'WAITING_INTERNAL_APPROVAL', 'REJECTED', 'APPROVED_MANUALLY',
      'REFUND_MANUALLY_PROCESSED', 'CLOSED',
    ] as const;

    const counts = await Promise.all(
      statuses.map(status =>
        this.returnService
          .adminListReturns({ status: status as any, limit: 1, page: 1 })
          .then(r => ({ status, count: r.total })),
      ),
    );

    const byStatus = counts.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = r.count;
      return acc;
    }, {});

    const highRisk = await this.returnService.adminListReturns({
      highRiskOnly: true, limit: 1, page: 1,
    });

    return {
      byStatus,
      highRiskPending: highRisk.total,
      financialSafetyStatus: {
        autoRefundEnabled:    false,   // ← ALWAYS false — system invariant
        autoSupplierEnabled:  false,
        autoInventoryEnabled: false,
        adminConsentRequired: true,
        message: 'All financial actions require explicit admin intervention. No automation active.',
      },
    };
  }

  // ── GET /admin/returns/:id ───────────────────────────────────────────────
  // Full return detail: customer + order + financial snapshot + fraud + history

  @Get(':id')
  @ApiOperation({ summary: 'Admin: Full return request details' })
  async getReturn(@Param('id', ParseUUIDPipe) id: string) {
    return this.returnService.adminGetReturn(id);
  }

  // ── PATCH /admin/returns/:id/action ─────────────────────────────────────
  // Approve / Reject / Freeze / Close / Add Note / Change Status
  // CRITICAL: This endpoint NEVER triggers financial actions.

  @Patch(':id/action')
  @ApiOperation({
    summary: 'Admin: Perform return moderation action',
    description:
      'Approve, reject, freeze, close, or add notes. ' +
      'Does NOT trigger any financial action. Use /refund for that.',
  })
  @ApiResponse({ status: 200, description: 'Action performed' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  async performAction(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AdminReturnActionDto,
    @Req() req: Request,
  ) {
    return this.returnService.adminPerformAction({
      returnRequestId: id,
      adminId:         user.sub,
      adminRole:       user.role,
      dto,
      ipAddress:       req.ip,
    });
  }

  // ── POST /admin/returns/:id/refund ───────────────────────────────────────
  // ⚠️  SOLE financial action path — superadmin + explicit confirmation only.
  //
  // CONTRACT:
  //   - Return MUST be in APPROVED_MANUALLY status
  //   - Body MUST contain confirmationPhrase: "CONFIRM_REFUND"
  //   - Actor MUST have superadmin role
  //   - This records the intent; finance team executes actual gateway refund
  //   - Immutably audited

  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  @Roles('superadmin')
  @ApiOperation({
    summary: 'Admin: Trigger manual refund (superadmin only)',
    description:
      'ONLY path to trigger refund from return system. ' +
      'Requires APPROVED_MANUALLY status + confirmationPhrase: "CONFIRM_REFUND". ' +
      'Records intent only — actual gateway execution done by finance team.',
  })
  @ApiResponse({ status: 200, description: 'Manual refund intent recorded' })
  @ApiResponse({ status: 400, description: 'Wrong status or missing confirmation' })
  @ApiResponse({ status: 403, description: 'Superadmin role required' })
  async triggerManualRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AdminManualRefundDto,
    @Req() req: Request,
  ) {
    return this.returnService.triggerManualRefund({
      returnRequestId: id,
      adminId:         user.sub,
      adminRole:       user.role,
      dto,
      ipAddress:       req.ip,
    });
  }

  // ── GET /admin/returns/:id/evidence ─────────────────────────────────────
  // Full evidence view WITH Telegram CDN references (admin-only)

  @Get(':id/evidence')
  @ApiOperation({ summary: 'Admin: View evidence including internal storage references' })
  async getEvidence(@Param('id', ParseUUIDPipe) id: string) {
    return this.evidenceService.getEvidenceForAdmin(id);
  }

  // ── POST /admin/returns/:id/evidence ────────────────────────────────────
  // Admin uploads internal evidence — marked is_admin_only, never shown to customer

  @Post(':id/evidence')
  @UseInterceptors(FilesInterceptor('files', 5))
  @ApiOperation({
    summary: 'Admin: Upload internal evidence (admin-only, not shown to customer)',
  })
  async uploadAdminEvidence(
    @Param('id', ParseUUIDPipe) returnRequestId: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    const tenantId = TenantContext.tryGet() ?? 'system';
    const results  = [];

    for (const file of files ?? []) {
      const result = await this.evidenceService.uploadEvidence({
        returnRequestId,
        tenantId,
        uploaderId:  user.sub,
        fileBuffer:  file.buffer,
        fileName:    file.originalname,
        mimeType:    file.mimetype,
        isAdminOnly: true,   // ← Never visible to customer
      });
      results.push(result);
    }

    return { success: true, uploaded: results };
  }

  // ── GET /admin/returns/:id/audit ─────────────────────────────────────────
  // Full immutable audit trail for a single return request

  @Get(':id/audit')
  @ApiOperation({ summary: 'Admin: Immutable audit trail for return request' })
  async getAuditTrail(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    return this.auditService.getAuditTrail({
      returnRequestId: id,
      limit:           limit  ? Number(limit)  : 100,
      offset:          offset ? Number(offset) : 0,
    });
  }

  // ── GET /admin/returns/audit/export ──────────────────────────────────────
  // Compliance export of all return audit logs (superadmin only)
  // Must be registered before /:id routes to avoid param collision

  @Get('audit/export')
  @Roles('superadmin')
  @ApiOperation({ summary: 'Admin: Export return audit logs for compliance (superadmin)' })
  async exportAuditLogs(
    @Query('from')     from?:     string,
    @Query('to')       to?:       string,
    @Query('tenantId') tenantId?: string,
    @Query('action')   action?:   string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const logs = await this.auditService.getAuditTrail({
      tenantId,
      action:  action as any,
      from:    from ? new Date(from) : undefined,
      to:      to   ? new Date(to)   : undefined,
      limit:   500,
    });

    const payload = {
      exportedAt:  new Date().toISOString(),
      count:       logs.length,
      exportedBy:  'admin-audit-export',
      logs,
    };

    if (res) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="return-audit-${Date.now()}.json"`,
      );
    }

    return payload;
  }

  // ── GET /admin/returns/:id/fraud-analysis ────────────────────────────────
  // Re-run fraud detection on demand — useful after new evidence is uploaded

  @Get(':id/fraud-analysis')
  @ApiOperation({
    summary: 'Admin: Re-run fraud analysis for return request',
    description: 'Produces fresh fraud assessment. Does not modify the return record.',
  })
  async analyzeFraud(@Param('id', ParseUUIDPipe) id: string) {
    const detail = await this.returnService.adminGetReturn(id);

    const freshAssessment = await this.fraudService.assess({
      customerId: detail['customer_id'] as string,
      orderId:    detail['order_id']    as string,
      tenantId:   detail['tenant_id']   as string,
    });

    return {
      returnRequestId: id,
      freshAssessment,
      storedRiskLevel: detail['risk_level'],
      storedRiskScore: detail['risk_score'],
      storedRiskFlags: detail['risk_flags'],
      diverged:
        freshAssessment.riskLevel !== detail['risk_level'] ||
        freshAssessment.riskScore !== detail['risk_score'],
    };
  }
}
