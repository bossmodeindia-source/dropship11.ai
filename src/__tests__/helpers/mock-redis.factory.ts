/**
 * mock-redis.factory.ts — In-memory Redis mock
 *
 * Implements SET NX EX, GET, DEL, HSET, HGET, EXPIRE patterns
 * used by webhook idempotency + plan limits + escrow guards.
 */

export function mockRedis() {
  const store: Record<string, { value: string; expiresAt?: number }> = {};

  const redis = {
    get: jest.fn(async (key: string): Promise<string | null> => {
      const entry = store[key];
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        delete store[key];
        return null;
      }
      return entry.value;
    }),

    set: jest.fn(async (key: string, value: string, ...args: any[]): Promise<'OK' | null> => {
      let ttlMs: number | undefined;
      let nx = false;
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'string' && args[i].toUpperCase() === 'NX') nx = true;
        if (typeof args[i] === 'string' && args[i].toUpperCase() === 'EX') ttlMs = (args[i + 1] ?? 60) * 1000;
        if (typeof args[i] === 'string' && args[i].toUpperCase() === 'PX') ttlMs = args[i + 1] ?? 60000;
      }
      if (nx && store[key] && (!store[key].expiresAt || Date.now() < store[key].expiresAt)) return null;
      store[key] = { value, expiresAt: ttlMs ? Date.now() + ttlMs : undefined };
      return 'OK';
    }),

    del:    jest.fn(async (key: string) => { delete store[key]; return 1; }),
    exists: jest.fn(async (key: string) => (store[key] ? 1 : 0)),
    expire: jest.fn(async (key: string, seconds: number) => {
      if (store[key]) { store[key].expiresAt = Date.now() + seconds * 1000; return 1; }
      return 0;
    }),
    hset:   jest.fn(async (key: string, field: string, value: string) => {
      store[`${key}:${field}`] = { value };
      return 1;
    }),
    hget:   jest.fn(async (key: string, field: string): Promise<string | null> => {
      return store[`${key}:${field}`]?.value ?? null;
    }),
    incr:   jest.fn(async (key: string) => {
      const current = parseInt(store[key]?.value ?? '0', 10);
      store[key] = { value: String(current + 1) };
      return current + 1;
    }),
    ping:   jest.fn(async () => 'PONG'),

    // Test helpers
    __setKey:        (key: string, value: string) => { store[key] = { value }; },
    __getStore:      () => store,
    __clearStore:    () => { Object.keys(store).forEach(k => delete store[k]); },
    __hasKey:        (key: string) => key in store,
  };

  return redis;
}
