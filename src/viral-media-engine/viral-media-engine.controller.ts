import {
  Controller, Post, Get, Body, Param, Query,
  HttpCode, HttpStatus, UseGuards, Request,
} from '@nestjs/common';
import {
  ViralMediaEngineService,
  LaunchMediaJobInput,
} from './viral-media-engine.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('api/v1/viral-media')
@UseGuards(JwtAuthGuard)
export class ViralMediaEngineController {

  constructor(private readonly engine: ViralMediaEngineService) {}

  /** Launch a viral media generation job */
  @Post('launch')
  @HttpCode(HttpStatus.ACCEPTED)
  async launchJob(@Body() dto: Omit<LaunchMediaJobInput, 'tenantId' | 'userId'>, @Request() req: any) {
    return this.engine.launchMediaJob({
      ...dto,
      tenantId: req.tenantId,
      userId:   req.user.id,
    });
  }

  /** Get job status */
  @Get('jobs/:jobId')
  async getJob(@Param('jobId') jobId: string, @Request() req: any) {
    return this.engine.getJobStatus(jobId, req.tenantId);
  }

  /** List jobs */
  @Get('jobs')
  async listJobs(@Query('limit') limit = '20', @Request() req: any) {
    return this.engine.listJobs(req.tenantId, parseInt(limit, 10));
  }

  /** Pipeline summary */
  @Get('summary')
  async getSummary(@Request() req: any) {
    return this.engine.getPipelineSummary(req.tenantId);
  }

  /** Admin: force execute from checkpoint */
  @Post('admin/execute/:jobId')
  @UseGuards(RolesGuard)
  @Roles('admin', 'superadmin')
  @HttpCode(HttpStatus.ACCEPTED)
  async adminExecute(
    @Param('jobId') jobId: string,
    @Body() body: { checkpoint?: string; tenantId: string },
  ) {
    const job = await this.engine.getJobStatus(jobId, body.tenantId);
    await this.engine.executePipelineFromCheckpoint(
      jobId,
      { tenantId: body.tenantId, userId: 'admin', mediaType: job.mediaType, targetPlatforms: [], variantCount: 1, autoPublish: false },
      (body.checkpoint ?? 'trend_discovery') as any,
    );
    return { ok: true };
  }
}
