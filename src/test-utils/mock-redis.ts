import { DynamicModule, Inject, Module } from '@nestjs/common';

type RedisValue = string | null;

export interface MockRedis {
  store: Map<string, string>;
  get: jest.Mock;
  set: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
  ping: jest.Mock;
  exists: jest.Mock;
  expire: jest.Mock;
  eval: jest.Mock;
  xadd: jest.Mock;
  incr: jest.Mock;
  scan: jest.Mock;
  ttl: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  duplicate: jest.Mock;
  on: jest.Mock;
  pipeline: jest.Mock;
}

export interface MockRedisPipeline {
  incr: jest.Mock;
  expire: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
  exec: jest.Mock;
}

export function getMockRedisToken(name = 'default'): string {
  return `RedisModule:${name}`;
}

export function createMockRedis(seed: Record<string, string> = {}): MockRedis {
  const store = new Map(Object.entries(seed));

  const redis = {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    ping: jest.fn(async () => 'PONG' as const),
    exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    expire: jest.fn(async () => 1),
    eval: jest.fn(async () => 1),
    xadd: jest.fn(async () => 'stream-id-1'),
    incr: jest.fn(async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    scan: jest.fn(async () => ['0', []]),
    ttl: jest.fn(async () => 60),
    quit: jest.fn(async () => 'OK' as const),
    disconnect: jest.fn(),
    duplicate: jest.fn(),
    on: jest.fn(function (this: MockRedis) {
      return this;
    }),
    pipeline: jest.fn(),
  } as MockRedis;

  redis.duplicate.mockReturnValue(redis);

  redis.pipeline.mockImplementation(() => {
    const results: Array<[null, unknown]> = [];
    const pipeline = {
      incr: jest.fn((key: string) => {
        results.push([null, Number(store.get(key) ?? '0') + 1]);
        return pipeline;
      }),
      expire: jest.fn(() => {
        results.push([null, 1]);
        return pipeline;
      }),
      get: jest.fn((key: string) => {
        results.push([null, store.get(key) ?? null]);
        return pipeline;
      }),
      set: jest.fn((key: string, value: string) => {
        store.set(key, value);
        results.push([null, 'OK']);
        return pipeline;
      }),
      exec: jest.fn(async () => results),
    } as MockRedisPipeline;
    return pipeline;
  });

  return redis;
}

export function installRedisMock(): void {
  function RedisMock() {
    return createMockRedis();
  }

  @Module({})
  class MockRedisNestModule {
    static forRoot(): DynamicModule {
      return redisDynamicModule();
    }

    static forRootAsync(): DynamicModule {
      return redisDynamicModule();
    }
  }

  function redisDynamicModule(): DynamicModule {
    return {
      module: MockRedisNestModule,
      global: true,
      providers: [{ provide: getMockRedisToken('default'), useFactory: () => createMockRedis() }],
      exports: [getMockRedisToken('default')],
    };
  }

  jest.doMock('ioredis', () => ({
    __esModule: true,
    default: RedisMock,
    Redis: RedisMock,
    Cluster: RedisMock,
  }));

  jest.doMock('@liaoliaots/nestjs-redis', () => ({
    __esModule: true,
    RedisModule: MockRedisNestModule,
    InjectRedis: (name = 'default') => Inject(getMockRedisToken(name)),
    getRedisToken: getMockRedisToken,
  }));
}
