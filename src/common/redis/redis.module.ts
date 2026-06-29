/**
 * redis.module.ts — V60 UNIFIED REDIS MODULE (Railway-compatible)
 *
 * Provides TWO compatible Redis injection tokens:
 *
 *   1. REDIS_CLIENT  (string token, V59 legacy)
 *      - Used by V59 services: RecoveryService, ConfigVaultService, etc.
 *      - Injected via: @Inject(REDIS_CLIENT) private redis: Redis
 *
 *   2. @InjectRedis() (decorator, V60 @liaoliaots/nestjs-redis)
 *      - Used by V60 services: DistributedLockService, DisasterRecoveryService
 *      - Injected via: @InjectRedis() private redis: Redis
 *
 * Both tokens reference the SAME underlying Redis connection.
 *
 * Connection resolution order (Railway-compatible):
 *   1. REDIS_URL env var  → used as-is (Railway, Upstash, Render, etc.)
 *   2. REDIS_HOST + REDIS_PORT + REDIS_PASSWORD → individual vars (Docker / local)
 *
 * TLS: auto-enabled when URL starts with rediss://
 *
 * @Global — imported once in AppModule, available everywhere.
 */

import { Module, Global }    from '@nestjs/common';
import { ConfigService }     from '@nestjs/config';
import { RedisModule as LLRedisModule } from '@liaoliaots/nestjs-redis';
import Redis, { RedisOptions } from 'ioredis';
import { DistributedLockService } from './distributed-lock.service';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT } from './redis.constants';

function buildRedisOptions(config: ConfigService): RedisOptions & { url?: string } {
  const url = config.get<string>('REDIS_URL');
  const base: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
    lazyConnect:          false,
    ...(url?.startsWith('rediss://') ? { tls: {} } : {}),
    retryStrategy(times: number) {
      return Math.min(times * 100, 3000);
    },
  };
  if (url) return { ...base, url };
  return {
    ...base,
    host:     config.get<string>('REDIS_HOST', 'localhost'),
    port:     config.get<number>('REDIS_PORT', 6379),
    password: config.get<string>('REDIS_PASSWORD') || undefined,
  };
}

@Global()
@Module({
  imports: [
    // @liaoliaots/nestjs-redis — provides @InjectRedis() decorator (used by V60 services)
    LLRedisModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        config: buildRedisOptions(config),
      }),
    }),
  ],
  providers: [
    // REDIS_CLIENT token — V59 backward-compat alias over the same ioredis instance
    {
      provide:  REDIS_CLIENT,
      inject:   [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const opts = buildRedisOptions(config);
        const client = opts.url
          ? new Redis(opts.url, opts)
          : new Redis(opts);
        client.on('error', (err) => {
          console.error('[RedisModule] REDIS_CLIENT error:', err.message);
        });
        client.on('connect', () => {
          console.log('[RedisModule] REDIS_CLIENT connected');
        });
        return client;
      },
    },
    DistributedLockService,
  ],
  exports: [
    REDIS_CLIENT,
    DistributedLockService,
    LLRedisModule, // re-export so @InjectRedis() works in any module that imports RedisModule
  ],
})
export class RedisModule {}
