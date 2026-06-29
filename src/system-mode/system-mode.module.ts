import { Module, Global } from '@nestjs/common';
import { SystemModeService } from './system-mode.service';
import { DatabaseModule }   from '../common/database/database.module';
import { RedisModule }      from '../common/redis/redis.module';

/**
 * SystemModeModule — V59 Global System State Controller
 *
 * @Global — injected everywhere without re-importing.
 * Depends on Redis (fast mode reads) + Database (persistent audit trail).
 */
@Global()
@Module({
  imports:   [DatabaseModule, RedisModule],
  providers: [SystemModeService],
  exports:   [SystemModeService],
})
export class SystemModeModule {}
