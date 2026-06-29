import { Injectable, ConflictException, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';

const IDEMPOTENCY_TTL_SECONDS = 86_400;
const PREFIX = 'idempotency:webhook:';

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async claim(key: string): Promise<boolean> {
    const result = await this.redis.set(
      `${PREFIX}${key}`, 'processing', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX',
    );
    return result === 'OK';
  }

  async complete(key: string, orderId: string): Promise<void> {
    await this.redis.set(`${PREFIX}${key}`, `done:${orderId}`, 'EX', IDEMPOTENCY_TTL_SECONDS);
  }

  async release(key: string): Promise<void> {
    await this.redis.del(`${PREFIX}${key}`);
    this.logger.warn(`Released idempotency key: ${key}`);
  }

  async guardOrThrow(key: string): Promise<void> {
    const claimed = await this.claim(key);
    if (!claimed) throw new ConflictException(`Duplicate webhook — key already processed: ${key}`);
  }
}
