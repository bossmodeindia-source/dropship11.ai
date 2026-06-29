process.env.NODE_ENV = 'test';
process.env.OTEL_SDK_DISABLED = 'true';

const redisStore = new Map<string, string>();

class JestRedisClient {
  get = jest.fn(async (key: string) => redisStore.get(key) ?? null);
  set = jest.fn(async (key: string, value: string) => {
    redisStore.set(key, value);
    return 'OK';
  });
  setex = jest.fn(async (key: string, _ttl: number, value: string) => {
    redisStore.set(key, value);
    return 'OK';
  });
  del = jest.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0));
  ping = jest.fn(async () => 'PONG');
  expire = jest.fn(async () => 1);
  eval = jest.fn(async () => 1);
  xadd = jest.fn(async () => 'stream-id-1');
  incr = jest.fn(async (key: string) => {
    const next = Number(redisStore.get(key) ?? '0') + 1;
    redisStore.set(key, String(next));
    return next;
  });
  scan = jest.fn(async () => ['0', []]);
  ttl = jest.fn(async () => 60);
  quit = jest.fn(async () => 'OK');
  disconnect = jest.fn();
  duplicate = jest.fn(() => this);
  on = jest.fn(() => this);
  pipeline = jest.fn(() => {
    const pipeline: Record<string, jest.Mock> = {
      incr: jest.fn(() => pipeline),
      expire: jest.fn(() => pipeline),
      get: jest.fn(() => pipeline),
      set: jest.fn(() => pipeline),
      exec: jest.fn(async () => []),
    };
    return pipeline;
  });
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: JestRedisClient,
  Redis: JestRedisClient,
  Cluster: JestRedisClient,
}));

class JestRazorpayClient {
  customers = { create: jest.fn(async () => ({ id: 'cust_test' })) };
  subscriptions = {
    create: jest.fn(async () => ({ id: 'sub_test', status: 'created' })),
    cancel: jest.fn(async () => ({ id: 'sub_test', status: 'cancelled' })),
  };
  orders = { create: jest.fn(async () => ({ id: 'order_test', status: 'created' })) };
  payments = {
    fetch: jest.fn(async () => ({ id: 'pay_test', status: 'captured' })),
    refund: jest.fn(async () => ({ id: 'refund_test', status: 'processed' })),
  };
}

jest.mock('razorpay', () => ({
  __esModule: true,
  default: JestRazorpayClient,
}));

jest.mock('@liaoliaots/nestjs-redis', () => {
  const { Global, Inject, Module } = jest.requireActual('@nestjs/common');
  const token = (name = 'default') => `RedisModule:${name}`;

  @Global()
  @Module({})
  class JestRedisModule {
    static forRoot() {
      return this.create();
    }

    static forRootAsync() {
      return this.create();
    }

    private static create() {
      return {
        module: JestRedisModule,
        global: true,
        providers: [{ provide: token(), useFactory: () => new JestRedisClient() }],
        exports: [token()],
      };
    }
  }

  return {
    __esModule: true,
    RedisModule: JestRedisModule,
    InjectRedis: (name = 'default') => Inject(token(name)),
    getRedisToken: token,
  };
});
