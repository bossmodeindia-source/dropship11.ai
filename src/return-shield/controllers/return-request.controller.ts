/**
 * ReturnRequestController — V64 Customer-Facing Return API
 *
 * Customer endpoints for submitting and tracking return requests.
 *
 * STOREFRONT BEHAVIOR:
 *   ✅ Customers see friendly "Return Product" UI
 *   ✅ Submit form with reason + evidence
 *   ✅ See "Your return is being reviewed" message
 *   ❌ Never see internal moderation status
 *   ❌ Never see admin notes, financial details, supplier info
 *   ❌ Never see Telegram file IDs or storage internals
 */

import {
  Controller, Post, Get, Param, Body,
  UseGuards, UseInterceptors, UploadedFiles,
  Req, HttpCode, HttpStatus, Logger, ParseUUIDPipe,
} from '@nestjs/common';
import { FilesInterceptor }             from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request }                      from 'express';
import { JwtAuthGuard }                 from '../../common/guards/jwt-auth.guard';
import { RolesGuard }                   from '../../common/guards/roles.guard';
import { CurrentUser, JwtPayload }      from '../../common/decorators/current-user.decorator';
import { TenantContext }                from '../../tenant/tenant.context';
import { ReturnRequestService }         from '../services/return-request.service';
import { ReturnEvidenceStorageService } from '../services/return-evidence-storage.service';
import {
  CreateReturnRequestDto,
  CustomerReturnStatusResponse,
} from '../dto/return-shield.dto';

@ApiTags('Returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/v1/returns')
export class ReturnRequestController {
  private readonly logger = new Logger(ReturnRequestController.name);

  constructor(
    private readonly returnService:   ReturnRequestService,
    private readonly evidenceService: ReturnEvidenceStorageService,
  ) {}

  // ── POST /api/v1/returns ─────────────────────────────────────────────────
  // Submit a return request. Response always says "processing" — never reveals
  // moderation state, admin decisions, or financial details.

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a return request',
    description: 'Customer submits a return for review. Does NOT trigger automatic refund.',
  })
  @ApiResponse({ status: 201, description: 'Return request submitted successfully' })
  @ApiResponse({ status: 409, description: 'Active return already exists for this order' })
  async submitReturn(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateReturnRequestDto,
    @Req() req: Request,
  ): Promise<{
    success: boolean;
    returnRequestId: string;
    message: string;
    status: string;
  }> {
    const tenantId = TenantContext.tryGet() ?? 'default';

    const result = await this.returnService.createReturnRequest({
      customerId: user.sub,
      tenantId,
      dto,
      ipAddress:  req.ip,
    });

    return {
      success:         true,
      returnRequestId: result.returnRequestId,
      // Always neutral customer-facing message — never reveals internal state
      message:         'Return request submitted successfully. Our team will review it shortly.',
      status:          'processing',
    };
  }

  // ── GET /api/v1/returns ──────────────────────────────────────────────────
  // List customer's own return requests (sanitized view)

  @Get()
  @ApiOperation({ summary: 'List my return requests' })
  async listMyReturns(
    @CurrentUser() user: JwtPayload,
  ): Promise<CustomerReturnStatusResponse[]> {
    const tenantId = TenantContext.tryGet() ?? 'default';
    return this.returnService.listCustomerReturns(user.sub, tenantId);
  }

  // ── GET /api/v1/returns/:id ──────────────────────────────────────────────
  // Get status of a specific return (sanitized — customer-safe only)

  @Get(':id')
  @ApiOperation({ summary: 'Get return request status' })
  @ApiResponse({ status: 200, description: 'Return status — customer-safe view only' })
  async getReturnStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CustomerReturnStatusResponse> {
    const tenantId = TenantContext.tryGet() ?? 'default';
    return this.returnService.getCustomerReturnStatus({
      returnRequestId: id,
      customerId:      user.sub,
      tenantId,
    });
  }

  // ── POST /api/v1/returns/:id/evidence ───────────────────────────────────
  // Upload evidence files (images, videos, screenshots, PDFs)

  @Post(':id/evidence')
  @UseInterceptors(FilesInterceptor('files', 5))
  @ApiOperation({
    summary: 'Upload evidence for a return request',
    description: 'Accepts images (JPG/PNG/WEBP), videos (MP4/MOV), and PDFs. Max 20MB each.',
  })
  async uploadEvidence(
    @Param('id', ParseUUIDPipe) returnRequestId: string,
    @CurrentUser() user: JwtPayload,
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<{
    success: boolean;
    uploaded: Array<{ fileName: string; fileType: string; evidenceId: string }>;
    message: string;
  }> {
    if (!files || files.length === 0) {
      return { success: false, uploaded: [], message: 'No files provided' };
    }

    const tenantId = TenantContext.tryGet() ?? 'default';
    const results: Array<{ fileName: string; fileType: string; evidenceId: string }> = [];

    for (const file of files) {
      const result = await this.evidenceService.uploadEvidence({
        returnRequestId,
        tenantId,
        uploaderId:  user.sub,
        fileBuffer:  file.buffer,
        fileName:    file.originalname,
        mimeType:    file.mimetype,
        isAdminOnly: false,
      });

      results.push({
        fileName:   result.fileName,
        fileType:   result.fileType,
        evidenceId: result.evidenceId,
      });
    }

    return {
      success:  true,
      uploaded: results,
      message:  `${results.length} file(s) uploaded successfully. They will be reviewed by our team.`,
    };
  }

  // ── GET /api/v1/returns/:id/evidence ────────────────────────────────────
  // Customer-safe evidence list — NO internal Telegram references exposed

  @Get(':id/evidence')
  @ApiOperation({ summary: 'List uploaded evidence for return request' })
  async listEvidence(
    @Param('id', ParseUUIDPipe) returnRequestId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.evidenceService.getEvidenceForCustomer(returnRequestId, user.sub);
  }
}
