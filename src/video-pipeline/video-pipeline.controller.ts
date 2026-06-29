// video-pipeline.controller.ts
import {
  Controller, Post, Get, Body, Param,
  UseGuards, Request, ParseUUIDPipe, Query,
} from '@nestjs/common';
import { VideoPipelineService, VideoPipelineInput } from './video-pipeline.service';
import { JwtAuthGuard } from '../common/guards';
import { IsString, IsIn, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';

class LaunchVideoPipelineDto {
  @IsString() productName: string;
  @IsString() productDescription: string;
  @IsString() targetAudience: string;
  @IsIn(['instagram','tiktok','youtube_shorts','facebook']) platform: 'instagram' | 'tiktok' | 'youtube_shorts' | 'facebook';
  @IsIn(['ugc','cinematic','minimal','testimonial']) style: 'ugc' | 'cinematic' | 'minimal' | 'testimonial';
  @IsIn([5,10,15,30]) durationSeconds: 5 | 10 | 15 | 30;
  @IsString() language: string;
  @IsString() niche: string;
  @IsOptional() campaignId?: string;
  @IsOptional() @IsIn(['A','B','C']) abVariant?: 'A' | 'B' | 'C';
}

@Controller('api/v1/video-pipeline')
@UseGuards(JwtAuthGuard)
export class VideoPipelineController {
  constructor(
    private readonly orchestrator: VideoPipelineService,
    @Inject(DB_POOL) private readonly db: Pool,
  ) {}

  /** Enqueue a new video generation job */
  @Post('launch')
  async launchPipeline(
    @Body() dto: LaunchVideoPipelineDto,
    @Request() req: any,
  ) {
    const input: VideoPipelineInput = { ...dto, tenantId: req.user.tenantId };
    return this.orchestrator.enqueue(input);
  }

  /** Get status of a video pipeline job */
  @Get('jobs/:jobId')
  async getJobStatus(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Request() req: any,
  ) {
    const result = await this.db.query(
      `SELECT id, status, virality_score, predicted_ctr, predicted_roas,
              reasoning_provider, image_provider, video_provider,
              error_message, retry_count, processing_ms,
              ab_variant, created_at, updated_at
       FROM video_pipeline_jobs
       WHERE id = $1 AND tenant_id = $2`,
      [jobId, req.user.tenantId],
    );
    return result.rows[0] ?? { error: 'Job not found' };
  }

  /** List recent video pipeline jobs for this tenant */
  @Get('jobs')
  async listJobs(
    @Request() req: any,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const lim = Math.min(parseInt(limit ?? '20'), 100);
    const result = await this.db.query(
      `SELECT id, status, virality_score, predicted_ctr, predicted_roas,
              ab_variant, reasoning_provider, image_provider, video_provider,
              error_message, processing_ms, created_at, updated_at
       FROM video_pipeline_jobs
       WHERE tenant_id = $1 ${status ? 'AND status = $3' : ''}
       ORDER BY created_at DESC LIMIT $2`,
      status ? [req.user.tenantId, lim, status] : [req.user.tenantId, lim],
    );
    return result.rows;
  }
}
