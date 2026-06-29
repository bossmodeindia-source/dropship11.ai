import { Module }          from '@nestjs/common';
import { TerminusModule }  from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseModule }  from '../common/database/database.module';
import { RedisModule }     from '../common/redis/redis.module';
import { QueueModule }     from '../queue/queue.module';

/**
 * HealthModule — V59 Deep Health Checks
 *
 * GET /health  — returns overall system health status.
 *
 * Checks performed:
 *   - PostgreSQL connection + latency (ping query)
 *   - Redis connection + latency (PING command)
 *   - BullMQ queue depth (warn if DLQ > 100 jobs)
 *   - Disk space (warn if < 10% free)
 *   - Memory heap (warn if > 85% used)
 *
 * Uses @nestjs/terminus for structured health check responses
 * compatible with K8s liveness + readiness probes.
 */
@Module({
  imports: [TerminusModule, DatabaseModule, RedisModule, QueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
