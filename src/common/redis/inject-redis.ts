import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.constants';

export function getRedisToken(name = 'default'): string {
  return name === 'default' ? REDIS_CLIENT : `RedisModule:${name}`;
}

export function InjectRedis(name = 'default'): ParameterDecorator {
  return Inject(getRedisToken(name));
}

