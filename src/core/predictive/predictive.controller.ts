/**
 * PredictiveController — V49
 *
 * GET /predictive/product/:id   — latest prediction for one product
 * GET /predictive/top           — top predicted products (last 24h)
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PredictiveEngine } from './predictive.engine';

@ApiTags('V49 Predictive')
@Controller('predictive')
export class PredictiveController {
  constructor(private readonly engine: PredictiveEngine) {}

  @Get('product/:id')
  @ApiOperation({ summary: 'Latest prediction for product' })
  async getForProduct(@Param('id') id: string) {
    const stored = await this.engine.getLatestForProduct(id);
    if (stored) return { productId: id, ...stored, source: 'cache' };
    const live = await this.engine.predict(id);
    return { productId: id, ...live, source: 'live' };
  }

  @Get('top')
  @ApiOperation({ summary: 'Top predicted products (last 24h)' })
  async getTop(@Query('limit') limit = '20') {
    return this.engine.getTopPredicted(Math.min(100, parseInt(limit, 10)));
  }
}
