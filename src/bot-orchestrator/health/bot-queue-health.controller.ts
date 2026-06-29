/**
 * BotQueueHealthController
 *
 * Exposes queue metrics, backpressure state, and rate-limit status
 * for dashboards, alerting, and ops tooling.
 *
 * Routes (all require admin auth):
 *   GET /bot-queue/health          — queue depths + backpressure state
 *   GET /bot-queue/metrics         — detailed per-queue metrics
 *   GET /bot-queue/global-load     — global concurrency utilisation
 *   GET /bot-queue/tenant/:id/load — per-tenant rate limit status
 *   POST /bot-queue/admin/reset-counter — reset rejected counter
 */

import {
  Controller, Get, Post, Param, UseGuards, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { BackpressureService } from '../rate-limiter/backpressure.service';
import { TenantRateLimiterService } from '../rate-limiter/tenant-rate-limiter.service';
import { BotQueueConfig } from '../queues/bot-queue.config';
import { TIER_FREE, TenantTier } from '../queues/bot-queue.constants';

// Replace with your actual admin guard
import { JwtAuthGuard } from '../../common/guards';

@ApiTags('Bot Queue')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bot-queue')
export class BotQueueHealthController {
  private readonly logger = new Logger(BotQueueHealthController.name);

  constructor(
    private readonly backpressure: BackpressureService,
    private readonly rateLimiter:  TenantRateLimiterService,
    private readonly queueConfig:  BotQueueConfig,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Queue system health snapshot' })
  async health() {
    const [bp, load] = await Promise.all([
      this.backpressure.getMetrics(),
      this.rateLimiter.getGlobalLoad(),
    ]);

    const healthy = bp.state !== 'overloaded' && load.utilization < 0.95;

    return {
      healthy,
      backpressure: bp,
      globalLoad:   load,
      timestamp:    new Date().toISOString(),
    };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Detailed queue metrics' })
  async metrics() {
    return {
      queues:    await this.queueConfig.getQueueMetrics(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('global-load')
  @ApiOperation({ summary: 'Global concurrency utilisation' })
  async globalLoad() {
    return this.rateLimiter.getGlobalLoad();
  }

  @Get('tenant/:tenantId/load')
  @ApiOperation({ summary: 'Per-tenant rate limit status' })
  async tenantLoad(
    @Param('tenantId') tenantId: string,
  ) {
    // Note: tier should be looked up from DB in production
    return this.rateLimiter.getTenantLoad(tenantId, TIER_FREE);
  }

  @Post('admin/reset-counter')
  @ApiOperation({ summary: 'Reset DLQ rejected counter (ops only)' })
  async resetCounter() {
    await this.backpressure.resetRejectedCounter();
    return { success: true, message: 'Rejected counter reset' };
  }
}
