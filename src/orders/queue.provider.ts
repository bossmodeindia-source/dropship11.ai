/**
 * queue.provider.ts — V70 Production Certified
 *
 * BullMQ Queue factory helpers.
 *
 * V70: BullMQ v4+ requires `connection` to be a ConnectionOptions object or
 * an IORedis client instance obtained via `ioredis` directly — NOT the
 * NestJS-injected Redis client (which may be wrapped). We use
 * redis.duplicate() to create a dedicated connection per queue, which is
 * the recommended BullMQ pattern to prevent command-response interleaving.
 */
import { Inject }         from '@nestjs/common';
import { Queue, Worker }  from 'bullmq';
import type { Redis }     from 'ioredis';
import { REDIS_CLIENT }   from '../common/redis/redis.module';

/** Create a BullMQ Queue with a dedicated duplicated Redis connection. */
export function createQueue(name: string, redis: Redis): Queue {
  return new Queue(name, {
    // BullMQ v4: use a duplicated connection to avoid pipeline conflicts
    connection: redis.duplicate() as any,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: false,
    },
  });
}

export const QUEUE_TOKEN = (name: string) => `QUEUE:${name}`;
export const InjectQueue  = (name: string) => Inject(QUEUE_TOKEN(name));

/** Dynamic NestJS provider factory for a named BullMQ queue. */
export function queueProvider(name: string) {
  return {
    provide:    QUEUE_TOKEN(name),
    inject:     [REDIS_CLIENT],
    useFactory: (redis: Redis) => createQueue(name, redis),
  };
}
