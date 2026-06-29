import { Module, Global } from '@nestjs/common';
import { ChaosService } from './chaos.service';

/**
 * Global ChaosModule — import in AppModule to make ChaosService
 * injectable everywhere when CHAOS_MODE=true.
 *
 * All ChaosService methods are no-ops unless CHAOS_MODE=true,
 * so this module is safe to include in all environments.
 */
@Global()
@Module({
  providers: [ChaosService],
  exports:   [ChaosService],
})
export class ChaosModule {}
