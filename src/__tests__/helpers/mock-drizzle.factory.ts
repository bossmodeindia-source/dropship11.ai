/**
 * mock-drizzle.factory.ts — V70 — In-memory Drizzle-compatible DB mock
 *
 * Provides a full mock implementing the DrizzleDB interface:
 *   - db.execute(sql`...`)    → in-memory query results
 *   - db.transaction(fn)      → runs fn with rollback support
 *   - db.insert(...)          → captures insert calls for assertion
 *   - db.$client.query(...)   → Pool-compatible query interface
 *   - db.query.*              → Drizzle relational API (findFirst / findMany)
 *
 * V70: Added explicit types to silence noImplicitAny
 */

type MockStore = Record<string, Record<string, unknown>[]>;

interface MockTxContext {
  execute:     jest.Mock;
  insert:      (schema: unknown) => { values: (vals: Record<string, unknown>) => { onConflictDoNothing: () => Promise<Record<string, unknown>[]>; returning: () => Promise<Record<string, unknown>[]> } };
  update:      jest.Mock;
}

export function mockDrizzleDb() {
  const store: MockStore = {
    orders:               [],
    escrow_transactions:  [],
    outbox_events:        [],
    supplier_payments:    [],
    profit_distributions: [],
    audit_logs:           [],
    commission_config:    [],
    return_requests:      [],
    shopify_api_keys:     [],
  };

  let _uniqueViolation: string | null = null;
  let _txRollbackOnNext               = false;

  // ── Core mock implementation ─────────────────────────────────────────────
  const execute = jest.fn(async (query: unknown): Promise<{ rows: Record<string, unknown>[] }> => {
    const sql    = (query as { queryChunks?: Array<{ value?: string }> })?.queryChunks
      ?.map(c => c?.value ?? '')
      .join('') ?? String(query);
    const table  = Object.keys(store).find(t => sql.toLowerCase().includes(t));
    return { rows: table ? store[table] : [] };
  });

  const makeInsert = (schema: unknown) => ({
    values: (vals: Record<string, unknown>) => ({
      onConflictDoNothing: (): Promise<Record<string, unknown>[]> => {
        if (_uniqueViolation) {
          const c = _uniqueViolation;
          _uniqueViolation = null;
          throw new Error(`duplicate key value violates unique constraint "${c}"`);
        }
        const row = { id: `gen-${Date.now()}`, ...vals };
        const tableName = (schema as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';
        if (store[tableName]) store[tableName].push(row);
        return Promise.resolve([row]);
      },
      returning: (): Promise<Record<string, unknown>[]> => {
        const row = { id: `gen-${Date.now()}`, ...vals };
        return Promise.resolve([row]);
      },
    }),
  });

  const db = {
    execute,

    transaction: jest.fn(async (fn: (tx: MockTxContext) => Promise<unknown>): Promise<unknown> => {
      const txContext: MockTxContext = {
        execute,
        insert: makeInsert,
        update: jest.fn(() => ({ set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis() })),
      };
      if (_txRollbackOnNext) {
        _txRollbackOnNext = false;
        throw new Error('Simulated transaction failure');
      }
      return fn(txContext);
    }),

    insert: jest.fn((schema: unknown) => ({
      values: jest.fn((vals: Record<string, unknown>) => ({
        onConflictDoNothing: jest.fn((): Promise<Record<string, unknown>[]> => {
          if (_uniqueViolation) {
            const c = _uniqueViolation;
            _uniqueViolation = null;
            throw new Error(`duplicate key value violates unique constraint "${c}"`);
          }
          return Promise.resolve([{ id: `gen-${Date.now()}`, ...vals }]);
        }),
        returning: jest.fn((): Promise<Record<string, unknown>[]> =>
          Promise.resolve([{ id: `gen-${Date.now()}`, ...vals }])
        ),
      })),
    })),

    select: jest.fn(() => ({
      from:  jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      then:  jest.fn(() => Promise.resolve([])),
    })),

    update: jest.fn(() => ({
      set:   jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      then:  jest.fn(() => Promise.resolve()),
    })),

    query: new Proxy({} as Record<string, { findFirst: jest.Mock; findMany: jest.Mock }>, {
      get: (_: unknown, tableName: string) => ({
        findFirst: jest.fn(async () => store[tableName]?.[0] ?? null),
        findMany:  jest.fn(async () => store[tableName] ?? []),
      }),
    }),

    $client: {
      query: jest.fn(async (text: string): Promise<{ rows: Record<string, unknown>[] }> => {
        const table = Object.keys(store).find(t => text.toLowerCase().includes(t));
        return { rows: table ? store[table] : [] };
      }),
    },

    // ── Test injection helpers ───────────────────────────────────────────────
    __injectOrphanEscrow:           (row: Record<string, unknown>) => store.escrow_transactions.push({ ...row, _orphan: true }),
    __injectOrphanPayment:          (row: Record<string, unknown>) => store.supplier_payments.push({ ...row, _orphan: true }),
    __injectStuckOutboxEvent:       (row: Record<string, unknown>) => store.outbox_events.push({ ...row, _stuck: true }),
    __injectReturnRequest:          (row: Record<string, unknown>) => store.return_requests.push(row),
    __setUniqueConstraintViolation: (name: string) => { _uniqueViolation = name; },
    __triggerNextTxRollback:        () => { _txRollbackOnNext = true; },
    __getStore:   () => store,
    __clearStore: () => { Object.keys(store).forEach(k => { store[k] = []; }); },
  };

  return db;
}
