import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

export interface RetryJob {
  service:   string;
  action:    string;
  payload:   unknown;
  attempt:   number;
  originErr: string;
}

const QUEUE_NAME = 'ops:retry';

@Injectable()
export class RetryQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetryQueueService.name);
  private queue!: Queue;
  private connection!: IORedis;
  private readonly workers = new Set<Worker>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.connection = new IORedis({
      host:     this.config.get('REDIS_HOST', 'localhost'),
      port:     this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get('REDIS_PASSWORD'),
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection as any,
      defaultJobOptions: {
        attempts: 5,
        backoff:  { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 200 },
        removeOnFail:     { count: 500 },
      },
    });

    this.logger.log('RetryQueue initialized');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.workers].map((worker) => worker.close()));
    this.workers.clear();
    if (this.queue) await this.queue.close();
    if (this.connection) await this.connection.quit();
  }

  async enqueue(job: RetryJob, overrideAttempts?: number): Promise<void> {
    await this.queue.add(`${job.service}:${job.action}`, job, {
      attempts: overrideAttempts ?? 5,
      backoff:  { type: 'exponential', delay: 2_000 },
    });
    this.logger.debug(`[RetryQueue] Enqueued ${job.service}:${job.action} attempt=${job.attempt}`);
  }

  registerProcessor(handler: (job: Job<RetryJob>) => Promise<void>, concurrency = 2): Worker {
    const worker = new Worker(QUEUE_NAME, handler, { connection: this.connection as any, concurrency });
    worker.on('failed', (job, err) => {
      this.logger.error(`[RetryQueue] Permanent failure id=${job?.id} err=${err.message}`);
    });
    this.workers.add(worker);
    return worker;
  }

  async getStats(): Promise<{ waiting: number; active: number; failed: number; completed: number }> {
    const [waiting, active, failed, completed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getFailedCount(),
      this.queue.getCompletedCount(),
    ]);
    return { waiting, active, failed, completed };
  }
}
