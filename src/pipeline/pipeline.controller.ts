/**
 * Pipeline REST Controller — exposes pipeline ops to the frontend.
 * Route prefix: /pipeline
 */

import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import { AdPipelineService }       from './modules/pipeline/ad-pipeline.service';
import { CreativeScoringService }  from './modules/creative-scoring/creative-scoring.service';
import { ThompsonSamplingService } from './modules/bandit/thompson-sampling.service';
import { V53FinanceLayer }         from './modules/v-layers/v-layers.service';

@Controller('pipeline')
export class PipelineController {
  private readonly logger = new Logger(PipelineController.name);

  constructor(
    private readonly pipeline: AdPipelineService,
    private readonly scoring:  CreativeScoringService,
    private readonly bandit:   ThompsonSamplingService,
    private readonly finance:  V53FinanceLayer,
  ) {}

  /**
   * POST /pipeline/run/:productId
   * Kick off the full V49 → Profit pipeline for a product.
   */
  @Post('run/:productId')
  @HttpCode(HttpStatus.ACCEPTED)
  async runPipeline(
    @Param('productId') productId: string,
    @Body() config: {
      test_budget?: number;
      max_creatives?: number;
      rounds?: number;
    } = {},
  ) {
    this.logger.log(`API: runPipeline productId=${productId}`);
    return this.pipeline.runAdPipeline(productId, config);
  }

  /**
   * POST /pipeline/score
   * Score a creative before launch — no budget spent.
   */
  @Post('score')
  async scoreCreative(
    @Body() input: {
      product: string;
      niche: string;
      hooks: string[];
      creative_type: 'video' | 'image';
      platform: 'instagram' | 'facebook' | 'tiktok';
      target_audience: string;
    },
  ) {
    return this.scoring.scoreCreative(input);
  }

  /**
   * POST /pipeline/score/batch
   * Score multiple creatives at once and return ranked list.
   */
  @Post('score/batch')
  async batchScore(
    @Body() body: { inputs: any[]; filter_rejected?: boolean },
  ) {
    return this.scoring.batchScore(body.inputs, body.filter_rejected ?? true);
  }

  /**
   * GET /pipeline/session/:sessionId
   * Get current bandit session state including arm stats.
   */
  @Get('session/:sessionId')
  getSession(@Param('sessionId') sessionId: string) {
    const session = this.bandit.getSession(sessionId);
    if (!session) return { error: 'Session not found' };

    const probBest = this.bandit.computeProbabilityBest(sessionId);
    return {
      ...session,
      probability_best: probBest,
    };
  }

  /**
   * GET /pipeline/finance/summary
   * Get overall P&L summary from V53.
   */
  @Get('finance/summary')
  getFinanceSummary() {
    return this.finance.getSummary();
  }

  /**
   * POST /pipeline/scale/:sessionId
   * Manually trigger winner duplication and scaling.
   */
  @Post('scale/:sessionId')
  @HttpCode(HttpStatus.OK)
  async scaleWinners(@Param('sessionId') sessionId: string) {
    const newIds = await this.pipeline.duplicateAndScaleWinners(sessionId);
    return { scaled: newIds.length, new_creative_ids: newIds };
  }

  /**
   * GET /pipeline/health
   * Basic health check for the pipeline module.
   */
  @Get('health')
  health() {
    return { status: 'ok', module: 'AdPipeline', timestamp: new Date().toISOString() };
  }
}
