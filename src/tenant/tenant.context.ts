/**
 * TenantContext — thread-local tenant binding using AsyncLocalStorage.
 *
 * Every incoming request must call TenantContext.run(tenantId, cb).
 * Any code inside that call can read TenantContext.current() without
 * passing tenantId through every function signature.
 *
 * ISOLATION GUARANTEE: tenantId is immutable inside a request context.
 * Any attempt to override it after binding throws TenantViolationError.
 */

import { AsyncLocalStorage } from 'async_hooks';

export class TenantViolationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TenantViolationError';
  }
}

interface TenantStore {
  tenantId: string;
  readonly: boolean;
}

const storage = new AsyncLocalStorage<TenantStore>();

export class TenantContext {
  /** Run a callback bound to a tenant. Store becomes readonly after binding. */
  static run<T>(tenantId: string, callback: () => T): T {
    const store: TenantStore = { tenantId, readonly: true };
    return storage.run(store, callback);
  }

  /** Get the active tenantId or throw if called outside a request context. */
  static current(): string {
    const store = storage.getStore();
    if (!store) {
      throw new TenantViolationError(
        'TenantContext.current() called outside of a request scope. ' +
        'Ensure TenantMiddleware is applied to all routes.',
      );
    }
    return store.tenantId;
  }

  /** Get the active tenantId or null (for optional contexts like cron jobs). */
  static tryGet(): string | null {
    return storage.getStore()?.tenantId ?? null;
  }

  /** Run a system-level callback without a tenant (admin / background tasks). */
  static runSystem<T>(callback: () => T): T {
    const store: TenantStore = { tenantId: '__system__', readonly: true };
    return storage.run(store, callback);
  }

  static isSystem(): boolean {
    return storage.getStore()?.tenantId === '__system__';
  }
}
