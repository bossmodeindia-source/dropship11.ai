import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from './metrics.service';
import { Public } from '../common/decorators/public.decorator';

/**
 * Exposes Prometheus metrics at GET /metrics.
 * In production, restrict this endpoint to internal network only
 * (e.g., via nginx allow/deny or a k8s NetworkPolicy).
 * It is intentionally @Public — Prometheus scraper has no JWT.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  async getMetrics(@Res() res: Response): Promise<void> {
    res.set('Content-Type', this.metrics.contentType());
    res.end(await this.metrics.getMetrics());
  }
}
