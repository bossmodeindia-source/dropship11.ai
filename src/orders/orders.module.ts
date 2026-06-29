import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { IdempotencyService } from './idempotency.service';
import { OrderQueueService } from './order-queue.service';
import { WebhookGuard } from './webhook.guard';

@Module({
  controllers: [OrdersController],
  providers: [
    OrdersService,
    IdempotencyService,
    OrderQueueService,
    WebhookGuard,
  ],
  exports: [OrdersService, OrderQueueService],
})
export class OrdersModule {}
