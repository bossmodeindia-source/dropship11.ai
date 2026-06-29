/**
 * TelegramStorageController — user-facing storage API.
 *
 * POST /storage/upload                   Upload a file (multipart/form-data)
 * GET  /storage/:id                      Get asset metadata
 * GET  /storage/:id/stream               Stream asset to browser
 * GET  /storage/:id/download-token       Get short-lived download token
 * DELETE /storage/:id                    Soft-delete an asset
 * GET  /storage/project/:projectId       List assets for a project
 * GET  /storage/campaign/:campaignId     List assets for a campaign
 *
 * All routes require JWT auth + tenant isolation.
 * Files are received via multer, validated, then handed to the orchestrator.
 */

import {
  Controller, Post, Get, Delete, Param, Query,
  UseGuards, UseInterceptors, UploadedFile,
  Req, Res, Body, HttpCode, HttpStatus,
  BadRequestException, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { FileInterceptor }          from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiOperation } from '@nestjs/swagger';
import { Response, Request }        from 'express';
import { JwtAuthGuard }             from '../common/guards/jwt-auth.guard';
import { TenantGuard }              from '../tenant/tenant.guard';
import { TelegramStorageFacade } from './telegram-storage-facade.service';
import { UploadAssetDto }           from './dto/upload-asset.dto';
import { AssetType }                from './telegram-storage.schema';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg','image/png','image/webp','image/gif',
  'video/mp4','video/webm','video/quicktime',
  'application/pdf',
  'application/zip','application/x-zip-compressed',
  'application/octet-stream',
  'text/plain','text/html','text/csv',
  'application/json',
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

@ApiTags('Storage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('storage')
export class TelegramStorageController {
  constructor(private readonly orchestrator: TelegramStorageFacade) {}

  // ── UPLOAD ──────────────────────────────────────────────────────────────────

  @Post('upload')
  @ApiOperation({ summary: 'Upload a file to Telegram storage (max 50MB)' })
  @ApiConsumes('multipart/form-data')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file', {
    limits:    { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return cb(new BadRequestException(`Unsupported MIME type: ${file.mimetype}`), false);
      }
      cb(null, true);
    },
  }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadAssetDto,
    @Req() req: any,
  ) {
    if (!file) throw new BadRequestException('No file provided');

    const result = await this.orchestrator.enqueueUpload({
      tenantId:   req.tenant.id,
      userId:     req.user.sub,
      fileBuffer: file.buffer,
      fileName:   file.originalname,
      mimeType:   file.mimetype,
      assetType:  dto.assetType as AssetType,
      projectId:  dto.projectId,
      campaignId: dto.campaignId,
      tags:       dto.tags,
    });

    return {
      success:       true,
      assetId:       result.id,
      storageStatus: result.storageStatus,
      deduped:       result.deduped,
      message:       result.storageStatus === 'stored'
        ? 'Asset stored successfully'
        : result.deduped
          ? 'Asset deduplicated — reusing existing file'
          : 'Asset queued for background upload',
    };
  }

  // ── METADATA ────────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get asset metadata' })
  async getAsset(@Param('id') id: string, @Req() req: any) {
    return this.orchestrator.getAsset(id, req.tenant.id);
  }

  // ── STREAM ──────────────────────────────────────────────────────────────────

  @Get(':id/stream')
  @ApiOperation({ summary: 'Stream asset content (proxied from Telegram)' })
  async streamAsset(
    @Param('id') id: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const { stream, mimeType, fileName, fileSize } = await this.orchestrator.streamAsset({
      assetId:  id,
      tenantId: req.tenant.id,
      userId:   req.user.sub,
      actorId:  req.user.sub,
    });

    res.set({
      'Content-Type':        mimeType,
      'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
      'Content-Length':      String(fileSize),
      'Cache-Control':       'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });

    stream.pipe(res);
  }

  // ── DOWNLOAD TOKEN ───────────────────────────────────────────────────────────

  @Get(':id/download-token')
  @ApiOperation({ summary: 'Get a short-lived (1h) download token for direct client access' })
  async getDownloadToken(@Param('id') id: string, @Req() req: any) {
    return this.orchestrator.getDownloadToken({
      assetId:  id,
      tenantId: req.tenant.id,
      userId:   req.user.sub,
    });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete an asset' })
  async deleteAsset(@Param('id') id: string, @Req() req: any) {
    await this.orchestrator.deleteAsset(id, req.tenant.id, req.user.sub, req.user.sub);
  }

  // ── LIST BY PROJECT ──────────────────────────────────────────────────────────

  @Get('project/:projectId')
  @ApiOperation({ summary: 'List assets for a project (paginated)' })
  async listProjectAssets(
    @Param('projectId') projectId: string,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: any,
  ) {
    return this.orchestrator.listProjectAssets(req.tenant.id, projectId, page, Math.min(limit, 100));
  }

  // ── LIST BY CAMPAIGN ─────────────────────────────────────────────────────────

  @Get('campaign/:campaignId')
  @ApiOperation({ summary: 'List assets for a campaign (paginated)' })
  async listCampaignAssets(
    @Param('campaignId') campaignId: string,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: any,
  ) {
    return this.orchestrator.listCampaignAssets(req.tenant.id, campaignId, page, Math.min(limit, 100));
  }
}
