import { Module, Global } from '@nestjs/common';
import { AlertingService } from './alerting.service';

/**
 * AlertingModule — V59 Telegram + Email Alert System
 *
 * @Global — any module can inject AlertingService without re-importing.
 * No internal NestJS DB/Redis deps — uses raw HTTPS calls to Telegram
 * Bot API and SendGrid, so it stays operational even if DB is down.
 */
@Global()
@Module({
  providers: [AlertingService],
  exports:   [AlertingService],
})
export class AlertingModule {}
