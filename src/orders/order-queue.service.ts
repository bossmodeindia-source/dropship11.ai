import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../common/redis/redis.module';

export interface OrderJobData {
  orderId: string;
  userId: string;
  platformOrderId: string;
  supplierType: string;
  retryCount: number;
}

@Injectable()
export class OrderQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderQueueService.name);
  readonly queue: Queue<OrderJobData>;
  private readonly dlq: Queue<OrderJobData>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    // BullMQ v4+: each Queue instance needs a dedicated connection via duplicate()
    this.queue = new Queue<OrderJobData>(
      this.config.get('ORDER_QUEUE', 'order:process'),
      {
        connection: this.redis.duplicate() as any,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: false,
        },
      },
    );

    this.dlq = new Queue<OrderJobData>(
      this.config.get('ORDER_DLQ', 'order:dlq'),
      { connection: this.redis.duplicate() as any },
    );
  }

  async enqueueOrder(data: OrderJobData): Promise<string> {
    const job = await this.queue.add('process-order', data, {
      jobId: `order:${data.orderId}`, // dedup by orderId
    });
    this.logger.log(`Enqueued order job ${job.id} for order ${data.orderId}`);
    return job.id!;
  }

  async moveToDlq(data: OrderJobData, reason: string): Promise<void> {
    await this.dlq.add('dead-letter', { ...data }, {
      jobId: `dlq:${data.orderId}`,
    });
    this.logger.error(`Order ${data.orderId} moved to DLQ. Reason: ${reason}`);
  }

  async getQueueDepth(): Promise<{ waiting: number; active: number; failed: number; dlq: number }> {
    const [waiting, active, failed, dlqWaiting] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getFailedCount(),
      this.dlq.getWaitingCount(),
    ]);
    return { waiting, active, failed, dlq: dlqWaiting };
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.dlq.close();
  }
}
