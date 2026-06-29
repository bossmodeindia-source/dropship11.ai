/**
 * test-module.factory.ts — NestJS test module builder
 *
 * Creates a minimal testing module with mocked infrastructure,
 * allowing domain services to be tested in isolation.
 */

import { ModuleMetadata }             from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { DB_TOKEN }                   from '../../common/database/database.module';
import { REDIS_CLIENT }               from '../../common/redis/redis.module';
import { ConfigModule }               from '@nestjs/config';

interface TestModuleOptions {
  db?:       any;
  redis?:    any;
  services?: any[];
  extra?:    ModuleMetadata;
}

export function createTestingModule(opts: TestModuleOptions = {}): TestingModuleBuilder {
  const { db, redis, services = [], extra = {} } = opts;

  const providers: any[] = [
    // Config
    ...(extra.providers ?? []),
  ];

  if (db)    providers.push({ provide: DB_TOKEN,     useValue: db    });
  if (redis) providers.push({ provide: REDIS_CLIENT, useValue: redis });

  providers.push(...services);

  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env.test' }),
      ...(extra.imports ?? []),
    ],
    providers,
    controllers: extra.controllers ?? [],
    exports:     extra.exports ?? [],
  });
}
