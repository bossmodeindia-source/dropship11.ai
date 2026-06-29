import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { MetaPerformanceService } from './meta-performance.service';

@ApiTags('meta-ads-performance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('meta-ads/performance')
export class MetaPerformanceController {
  constructor(
    private readonly performanceService: MetaPerformanceService,
  ) {}

  /**
   * POST /meta-ads/performance/run-cycle
   * Manually trigger the full performance + scaling cycle across all
   * active Meta campaigns (useful for on-demand runs or testing).
   */
  @Post('run-cycle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger a full performance & scaling cycle (all campaigns)' })
  runCycle(): Promise<{ processed: number; errors: number }> {
    return this.performanceService.runFullCycle();
  }

  /**
   * GET /meta-ads/performance/campaign/:id
   * Fetch fresh metrics and evaluate performance for a single campaign.
   * Writes results to the DB and returns them in the response.
   */
  @Get('campaign/:id')
  @ApiOperation({ summary: 'Get & evaluate performance metrics for one campaign' })
  async getCampaignMetrics(
    @Param('id', ParseUUIDPipe) campaignId: string,
  ): Promise<{
    metrics:  ReturnType<MetaPerformanceService['evaluatePerformance']>['metrics'];
    decision: Omit<ReturnType<MetaPerformanceService['evaluatePerformance']>, 'metrics'>;
  }> {
    const metrics  = await this.performanceService.fetchMetrics(campaignId);
    const decision = this.performanceService.evaluatePerformance(metrics);
    const { metrics: _m, ...rest } = decision;
    return { metrics, decision: rest };
  }

  /**
   * POST /meta-ads/performance/campaign/:id/process
   * Run the full fetch → evaluate → persist → scale pipeline for one campaign.
   */
  @Post('campaign/:id/process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Process performance & scaling for one campaign' })
  async processCampaign(
    @Param('id', ParseUUIDPipe) campaignId: string,
  ): Promise<{ ok: boolean }> {
    await this.performanceService.processCampaign(campaignId);
    return { ok: true };
  }
}
