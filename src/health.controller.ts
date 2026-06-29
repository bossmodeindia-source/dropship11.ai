import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheckService, HealthCheck, HealthCheckResult, HealthIndicatorResult } from '@nestjs/terminus';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Public } from './common/decorators/public.decorator';
import { POOL_TOKEN } from './common/database/database.module';
import { REDIS_CLIENT } from './common/redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(POOL_TOKEN) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.checkPostgres(),
      () => this.checkRedis(),
    ]);
  }

  private async checkPostgres(): Promise<HealthIndicatorResult> {
    const start = Date.now();
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      return { postgres: { status: 'up', latencyMs: Date.now() - start } };
    } catch (err) {
      return { postgres: { status: 'down', error: (err as Error).message } };
    }
  }

  private async checkRedis(): Promise<HealthIndicatorResult> {
    const start = Date.now();
    try {
      const pong = await this.redis.ping();
      return { redis: { status: (pong === 'PONG' ? 'up' : 'down') as 'up' | 'down', latencyMs: Date.now() - start } };
    } catch (err) {
      return { redis: { status: 'down', error: (err as Error).message } };
    }
  }
}
