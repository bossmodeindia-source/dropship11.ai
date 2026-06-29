/**
 * PlatformAdsController — V60 PATCHED
 *
 * Fixes applied:
 *   [C3] buildAudiences() endpoint strips the emails field before returning.
 *        PlatformRetargetingService.buildAllAudiences() now returns
 *        RetargetingAudienceResult without emails — this controller layer adds
 *        a belt-and-suspenders strip to guarantee PII never appears in the HTTP
 *        response even if the service type changes in a future merge.
 *
 *   [PAUSEALL-DTO] pauseAll() now uses a validated PauseAllDto with:
 *        - reason: string (required, 3–500 chars, IsString)
 *        This produces a proper audit trail instead of silently defaulting
 *        to 'Manual override' when reason is omitted.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { PlatformAdsService } from './platform-ads.service';
import { PlatformCampaignService, CreatePlatformCampaignDto } from './platform-campaign.service';
import { PlatformAnalyticsService, MetricsSyncPayload } from './platform-analytics.service';
import { PlatformRetargetingService } from './platform-retargeting.service';
import { PlatformCreativeService, PlatformCreativeStyle } from './platform-creative.service';

// ── DTOs ──────────────────────────────────────────────────────────────────────

/**
 * [PAUSEALL-DTO FIX] Validated DTO for pauseAll — reason is now required and
 * constrained so every pause has a meaningful audit trail.
 */
export class PauseAllDto {
  @IsString()
  @MinLength(3, { message: 'reason must be at least 3 characters — provide a meaningful audit reason' })
  @MaxLength(500)
  reason: string;
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('Platform Ads (Admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
@Controller('admin/platform-ads')
export class PlatformAdsController {

  constructor(
    private readonly platformAds: PlatformAdsService,
    private readonly campaigns:   PlatformCampaignService,
    private readonly analytics:   PlatformAnalyticsService,
    private readonly retargeting: PlatformRetargetingService,
    private readonly creatives:   PlatformCreativeService,
  ) {}

  // ── Dashboard ─────────────────────────────────────────────────────────────

  @Get('dashboard')
  @ApiOperation({ summary: 'Platform ads admin dashboard — CAC, ROAS, signups, spend' })
  async getDashboard() {
    return this.platformAds.getDashboard();
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────

  @Get('campaigns')
  @ApiOperation({ summary: 'List all platform campaigns' })
  async listCampaigns() {
    return this.campaigns.listCampaigns();
  }

  @Get('campaigns/:id')
  @ApiOperation({ summary: 'Get platform campaign by ID' })
  async getCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.getCampaign(id);
  }

  @Post('campaigns')
  @ApiOperation({ summary: 'Create a new platform campaign (with auto creative generation)' })
  async createCampaign(@Body() dto: CreatePlatformCampaignDto) {
    return this.campaigns.createCampaign(dto);
  }

  @Post('campaigns/:id/launch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Launch platform campaign on Meta Ads' })
  async launchCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.launchCampaign(id);
  }

  @Patch('campaigns/:id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause a platform campaign' })
  async pauseCampaign(@Param('id', ParseUUIDPipe) id: string) {
    await this.campaigns.pauseCampaign(id);
    return { message: 'Campaign paused' };
  }

  @Patch('campaigns/:id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a paused platform campaign' })
  async resumeCampaign(@Param('id', ParseUUIDPipe) id: string) {
    await this.campaigns.resumeCampaign(id);
    return { message: 'Campaign resumed' };
  }

  @Post('campaigns/pause-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Emergency: pause all platform campaigns' })
  @ApiBody({ type: PauseAllDto })
  async pauseAll(@Body() dto: PauseAllDto) {
    // [PAUSEALL-DTO FIX] reason is now validated — no silent default
    await this.platformAds.pauseAll(dto.reason);
    return { message: 'All platform campaigns paused', reason: dto.reason };
  }

  // ── Scaling ───────────────────────────────────────────────────────────────

  @Get('campaigns/:id/scaling-decision')
  @ApiOperation({ summary: 'Get AI scaling recommendation for a campaign' })
  async getScalingDecision(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.evaluateScaling(id);
  }

  @Post('campaigns/:id/apply-scaling')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply AI scaling decision for a campaign' })
  async applyScaling(@Param('id', ParseUUIDPipe) id: string) {
    const decision = await this.campaigns.evaluateScaling(id);
    await this.campaigns.applyScalingDecision(id, decision);
    return { applied: decision };
  }

  // ── Creatives ─────────────────────────────────────────────────────────────

  @Post('creatives/generate')
  @ApiOperation({ summary: 'Generate a platform ad creative bundle' })
  async generateCreative(
    @Body() body: { style: PlatformCreativeStyle; campaignId?: string },
  ) {
    return this.creatives.generateBundle(body.style, body.campaignId);
  }

  @Get('campaigns/:id/winner-creative')
  @ApiOperation({ summary: 'Pick winner creative via Thompson Sampling' })
  async getWinnerCreative(@Param('id', ParseUUIDPipe) id: string) {
    return this.creatives.pickWinnerThompson(id);
  }

  @Patch('creatives/:id/result')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record creative win/loss for Thompson Sampling' })
  async recordCreativeResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { won: boolean },
  ) {
    await this.creatives.recordResult(id, body.won);
    return { message: 'Creative result recorded' };
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  @Post('metrics/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ingest performance metrics from Meta Ads sync' })
  async syncMetrics(@Body() payload: MetricsSyncPayload) {
    await this.analytics.syncMetrics(payload);
    return { message: 'Metrics synced' };
  }

  @Get('campaigns/:id/metrics')
  @ApiOperation({ summary: 'Get campaign metrics (last N days)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getCampaignMetrics(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
  ) {
    return this.analytics.getCampaignMetrics(id, days);
  }

  @Post('analytics/snapshot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger daily growth analytics snapshot manually' })
  async triggerSnapshot() {
    await this.analytics.snapshotDailyGrowth();
    return { message: 'Snapshot saved' };
  }

  // ── Retargeting ───────────────────────────────────────────────────────────

  @Get('retargeting/segments')
  @ApiOperation({ summary: 'List retargeting audience segments' })
  async listRetargetingSegments() {
    return this.retargeting.listSegments();
  }

  @Post('retargeting/build-audiences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Build retargeting audiences — returns audience sizes and Meta IDs only',
    description:
      'Emails are SHA-256 hashed and uploaded directly to Meta Custom Audiences. ' +
      'Raw email addresses are never included in the API response.',
  })
  async buildAudiences() {
    const results = await this.retargeting.buildAllAudiences();

    // [C3] Belt-and-suspenders: strip any emails field even if type evolves
    return results.map(({ segment, audienceSize, metaAudienceId }) => ({
      segment,
      audienceSize,
      metaAudienceId,
    }));
  }

  @Post('retargeting/launch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Launch retargeting campaigns for all ready segments' })
  async launchRetargeting() {
    await this.retargeting.launchRetargetingCampaigns();
    return { message: 'Retargeting campaigns launched' };
  }

  // ── Cost protection ───────────────────────────────────────────────────────

  @Post('spend-cap/check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check and enforce daily platform spend cap' })
  async checkSpendCap() {
    await this.campaigns.enforceSpendCap();
    return { message: 'Spend cap check complete' };
  }
}
