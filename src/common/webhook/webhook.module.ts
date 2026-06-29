/**
 * WebhookModule — Universal Webhook Infrastructure
 *
 * @Global — WebhookIdempotencyService is available everywhere.
 * Import into AppModule before any module that handles webhooks.
 */

import { Global, Module } from '@nestjs/common';
import { WebhookIdempotencyService } from './webhook-idempotency.service';

@Global()
@Module({
  providers: [WebhookIdempotencyService],
  exports:   [WebhookIdempotencyService],
})
export class WebhookModule {}
