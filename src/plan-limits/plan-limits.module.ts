import { Module, Global } from '@nestjs/common';
import { PlanLimitsService } from './plan-limits.service';
import { DatabaseModule }   from '../common/database/database.module';
import { RedisModule }      from '../common/redis/redis.module';

/**
 * PlanLimitsModule — V59 Free/Pro/Elite Quota Enforcement
 *
 * @Global — plan checks occur at many call-sites (controllers, services,
 * workers) so PlanLimitsService must be injectable everywhere.
 *
 * Depends on:
 *   DatabaseModule — subscription tier lookup
 *   RedisModule    — per-tenant daily usage counters (5-min cache)
 */
@Global()
@Module({
  imports:   [DatabaseModule, RedisModule],
  providers: [PlanLimitsService],
  exports:   [PlanLimitsService],
})
export class PlanLimitsModule {}
