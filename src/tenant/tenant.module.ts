/**
 * TenantModule — V59 Multi-Tenant Isolation
 *
 * Exports:
 *   TenantMiddleware    — JWT extraction + tenant binding (apply in AppModule.configure)
 *   TenantGuard         — Global guard enforcing tenant presence on all routes
 *   TenantScopedRepository — Base class for DB isolation
 *   TenantContext       — AsyncLocalStorage tenant binding (no DI needed)
 *
 * Register in AppModule:
 *   imports: [TenantModule]
 *   providers: [{ provide: APP_GUARD, useClass: TenantGuard }]
 *
 * And in configure(consumer):
 *   consumer.apply(TenantMiddleware).forRoutes('*')
 */

import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TenantMiddleware } from './tenant.middleware';
import { TenantGuard } from './tenant.guard';
import { TenantScopedRepository } from './tenant-scoped.repository';
import { RedisModule } from '../common/redis/redis.module';
import { DatabaseModule } from '../common/database/database.module';

@Global()
@Module({
  imports: [
    RedisModule,
    DatabaseModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [TenantMiddleware, TenantGuard, TenantScopedRepository],
  exports: [TenantMiddleware, TenantGuard, TenantScopedRepository],
})
export class TenantModule {}
