/**
 * OutboxModule — Transactional Outbox Pattern
 *
 * @Global — OutboxService must be available everywhere a DB transaction occurs.
 *
 * Add to AppModule imports BEFORE any domain module that emits events:
 *   OutboxModule,  // after DatabaseModule, AlertingModule
 */

import { Module, Global } from '@nestjs/common';
import { OutboxService }  from './outbox.service';

@Global()
@Module({
  providers: [OutboxService],
  exports:   [OutboxService],
})
export class OutboxModule {}
