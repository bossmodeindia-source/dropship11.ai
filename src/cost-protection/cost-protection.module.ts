import { Module, Global } from '@nestjs/common';
import { CostProtectionService } from './cost-protection.service';
import { RedisModule }           from '../common/redis/redis.module';
import { AlertingModule }        from '../alerting/alerting.module';

/**
 * CostProtectionModule — V59 Per-Tenant Spend Cap Enforcement
 *
 * @Global — guards on campaign launch + AI generation call-sites across
 * all modules need CostProtectionService without re-importing.
 *
 * Depends on:
 *   RedisModule    — sliding-window daily spend counters
 *   AlertingModule — breach alerts (Telegram + email)
 */
@Global()
@Module({
  imports:   [RedisModule, AlertingModule],
  providers: [CostProtectionService],
  exports:   [CostProtectionService],
})
export class CostProtectionModule {}
