import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { DB_POOL, DB_TOKEN, POOL_TOKEN } from '../common/database/database.module';
import { DatabaseService } from '../common/database/database.service';
import { createMockDrizzle, createMockPool, installPgMock, MockPool } from './mock-drizzle';
import { createMockRedis, getMockRedisToken, installRedisMock, MockRedis } from './mock-redis';
import { installBullMqMocks } from './mock-bullmq';
import { OptimizationScheduler } from '../workers/optimization.scheduler';

export interface TestAppContext {
  app: INestApplication;
  redis: MockRedis;
  db: any;
  pool: MockPool;
}

export interface TestAppOptions {
  imports?: Array<Type<unknown> | Promise<Type<unknown>>>;
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  beforeInit?: (app: INestApplication) => void | Promise<void>;
  useDefaultValidationPipe?: boolean;
}

export function setTestEnv(): void {
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters';
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
  process.env.WEBHOOK_HMAC_SECRET ??= 'test-webhook-secret-at-least-32-chars';
  process.env.SHOPIFY_WEBHOOK_SECRET ??= process.env.WEBHOOK_HMAC_SECRET;
  process.env.INTERNAL_SERVICE_KEY ??= 'test-internal-service-key-at-least-32';
  process.env.ENCRYPTION_MASTER_KEY ??=
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.REDIS_HOST ??= '127.0.0.1';
  process.env.REDIS_PORT ??= '6379';
  process.env.RAZORPAY_KEY_ID ??= 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET ??= 'rzp_test_secret';
  process.env.RAZORPAY_WEBHOOK_SECRET ??= 'test-razorpay-webhook-secret';
  process.env.STORAGE_ACCESS_KEY ??= 'test-storage-access-key';
  process.env.STORAGE_SECRET_KEY ??= 'test-storage-secret-key';
  process.env.STORAGE_BUCKET ??= 'test-storage-bucket';
  process.env.BANK_ENCRYPTION_KEY ??= process.env.ENCRYPTION_MASTER_KEY;
  process.env.VAULT_MASTER_KEY ??= process.env.ENCRYPTION_MASTER_KEY;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestAppContext> {
  setTestEnv();
  const redis = createMockRedis();
  const pool = createMockPool();
  const db = createMockDrizzle();

  installRedisMock();
  installPgMock(pool);
  installBullMqMocks();

  const imports = options.imports?.length
    ? await Promise.all(options.imports)
    : [await import('../app.module').then((m) => m.AppModule)];

  let builder = Test.createTestingModule({ imports });
  builder = builder
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .overrideProvider(POOL_TOKEN)
    .useValue(pool)
    .overrideProvider(DB_POOL)
    .useValue(pool)
    .overrideProvider(DatabaseService)
    .useValue(new DatabaseService(pool as any))
    .overrideProvider(OptimizationScheduler)
    .useValue({
      runOptimizationCycle: jest.fn(),
      triggerManualCycle: jest.fn().mockResolvedValue({ triggered: true }),
      getStatus: jest
        .fn()
        .mockReturnValue({ lastRunAt: null, isRunning: false, cyclesCompleted: 0 }),
    })
    .overrideProvider(getMockRedisToken('default'))
    .useValue(redis)
    .overrideProvider('REDIS_CLIENT')
    .useValue(redis);

  if (options.configure) {
    builder = options.configure(builder);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  if (options.useDefaultValidationPipe !== false) {
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  }
  await options.beforeInit?.(app);
  await app.init();

  return { app, redis, db, pool };
}
