type QueryResult = { rows: any[] };

export interface MockPool {
  query: jest.Mock;
  connect: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
}

export interface MockPoolClient {
  query: jest.Mock;
  release: jest.Mock;
}

export function createMockPool(rows: any[] = []): MockPool {
  const client: MockPoolClient = {
    query: jest.fn(async () => ({ rows })),
    release: jest.fn(),
  };

  return {
    query: jest.fn(async () => ({ rows })),
    connect: jest.fn(async () => client),
    end: jest.fn(async () => undefined),
    on: jest.fn(function (this: MockPool) {
      return this;
    }),
  };
}

export function createMockDrizzle(rows: any[] = []): any {
  const db: any = {
    select: jest.fn(() => db),
    from: jest.fn(() => db),
    where: jest.fn(() => db),
    orderBy: jest.fn(() => db),
    groupBy: jest.fn(() => db),
    limit: jest.fn(async () => rows),
    offset: jest.fn(() => db),
    insert: jest.fn(() => db),
    values: jest.fn(() => db),
    update: jest.fn(() => db),
    set: jest.fn(() => db),
    delete: jest.fn(() => db),
    returning: jest.fn(async () => rows.length ? rows : [{ id: 'test-id' }]),
    execute: jest.fn(async () => ({ rows })),
    transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
    query: {
      products: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      campaigns: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      campaignMetrics: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      subscriptions: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      users: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      orders: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      wallets: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    },
  };

  db.$client = createMockPool(rows);
  return db;
}

export function installPgMock(pool = createMockPool()): void {
  jest.doMock('pg', () => ({
    __esModule: true,
    Pool: class Pool {
      constructor() {
        return pool;
      }
    },
  }));
}
