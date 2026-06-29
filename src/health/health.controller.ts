/**
 * HealthController — V59 Health + Readiness Checks
 *
 * GET /health           — liveness probe (returns 200 if process alive)
 * GET /health/ready     — readiness probe (DB + Redis connected)
 * GET /health/deep      — full system check (all dependencies)
 * GET /metrics          — Prometheus metrics exposition
 */

import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { DB_POOL }       from '../common/database/database.module';
import { REDIS_CLIENT }  from '../common/redis/redis.module';
import { FailSafeService } from '../failsafe/failsafe.service';
import { SystemModeService } from '../system-mode/system-mode.service';
import { ObservabilityService } from '../observability/observability.service';
import { SkipTenantGuard } from '../tenant/tenant.guard';
import { Response } from 'express';
import { Res } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Health')
@Public()
@SkipTenantGuard()
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DB_POOL)      private readonly db:     Pool,
    @Inject(REDIS_CLIENT) private readonly redis:  Redis,
    private readonly failSafe:    FailSafeService,
    private readonly systemMode:  SystemModeService,
    private readonly obs:         ObservabilityService,
  ) {}

  /** Liveness — just confirms process is alive */
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  liveness() {
    return {
      status:    'ok',
      timestamp: new Date().toISOString(),
      version:   process.env.npm_package_version ?? 'v59',
      mode:      this.systemMode.getMode(),
    };
  }

  /** Readiness — confirms DB + Redis are reachable */
  @Get('health/ready')
  @ApiOperation({ summary: 'Readiness probe' })
  async readiness() {
    const checks = await Promise.allSettled([
      this.db.query('SELECT 1'),
      this.redis.ping(),
    ]);

    const dbOk    = checks[0].status === 'fulfilled';
    const redisOk = checks[1].status === 'fulfilled';
    const ready   = dbOk && redisOk;

    return {
      status:    ready ? 'ready' : 'not_ready',
      checks: {
        database: dbOk    ? 'ok' : 'failed',
        redis:    redisOk ? 'ok' : 'failed',
      },
      timestamp: new Date().toISOString(),
    };
  }

  /** Deep health — full dependency status */
  @Get('health/deep')
  @ApiOperation({ summary: 'Deep system health check' })
  async deep() {
    return {
      mode:         this.systemMode.getMode(),
      state:        this.systemMode.getState(),
      dependencies: this.failSafe.getStatus(),
      healthy:      this.failSafe.isHealthy(),
      adsEnabled:   this.systemMode.isAdsEnabled(),
      organicEnabled: this.systemMode.isOrganicEnabled(),
      timestamp:    new Date().toISOString(),
    };
  }

  /** Prometheus metrics endpoint */
  @Get('metrics')
  @ApiOperation({ summary: 'Prometheus metrics' })
  async metrics(@Res() res: Response) {
    res.set('Content-Type', this.obs.getContentType());
    res.end(await this.obs.getMetrics());
  }
}
