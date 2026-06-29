import { Module, Global } from '@nestjs/common';
import { FailSafeService } from './failsafe.service';
import { AlertingModule }  from '../alerting/alerting.module';
import { SystemModeModule } from '../system-mode/system-mode.module';
import { QueueModule }     from '../queue/queue.module';

/**
 * FailSafeModule — V59 Circuit Breaker + Auto-Recovery
 *
 * Depends on:
 *   AlertingModule   — sends Telegram/email on circuit open
 *   SystemModeModule — switches to 'safe' mode on critical failure
 *   QueueModule      — pauses all queues on circuit open
 */
@Global()
@Module({
  imports: [AlertingModule, SystemModeModule, QueueModule],
  providers: [FailSafeService],
  exports: [FailSafeService],
})
export class FailSafeModule {}
