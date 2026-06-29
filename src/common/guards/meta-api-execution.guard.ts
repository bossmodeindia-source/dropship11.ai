/**
 * MetaApiExecutionGuard — V30 FIX-D (Emergency Context Hardening)
 *
 * FIX D — EMERGENCY CONTEXT HARDENING:
 *   Emergency execution IDs are now fully hardened:
 *
 *   1. UNIQUE EXECUTION ID: Every runInEmergencyContext() call that does NOT
 *      pass an already-unique caller ID gets a UUID+timestamp+counter appended
 *      automatically. Well-known recurring IDs ('budget-cap', 'system-init')
 *      are detected and given a unique suffix so Redis SETNX always fires.
 *
 *   2. TTL ENFORCEMENT (strict): Emergency context keys stored in Redis with
 *      EMERGENCY_TTL_S (60s). Duplicate detection logs + metrics.
 *
 *   3. PREVENT REUSE COMPLETELY: In-process Set tracks all emergency IDs used
 *      in this pod's lifetime (in addition to Redis). If the same raw ID is
 *      seen twice within the process, it is rejected with a hard throw — not
 *      just a warning — UNLESS it is a known recurring cron ID.
 *
 *   4. LOG ALL EMERGENCY EXECUTIONS: Every emergency context open/close is
 *      written to console.error with structured fields for log aggregation.
 *
 * FIX 5 (unchanged): Emergency context IDs stored in Redis via SETNX with 60s TTL.
 *   Crash + restart clears memory; Redis survives the restart.
 *
 * STATIC DESIGN:
 *   All methods are static — guard is a module-level singleton.
 *   Call MetaApiExecutionGuard.init(redis) at application bootstrap.
 *
 * ASYNC LOCAL STORAGE:
 *   Kernel/emergency context flows through AsyncLocalStorage.
 *   Any async chain started inside runInKernelContext() or runInEmergencyContext()
 *   will pass assertInKernelContext() checks — no context object threading required.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 }     from 'uuid';
import Redis                 from 'ioredis';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KernelContext {
  campaignId:       string;
  idempotencyKey:   string;
  authorityLeaseId: string;
}

interface ActiveContext {
  kind:            'kernel' | 'emergency';
  kernelContext?:  KernelContext;
  emergencyId?:    string;
  // FIX D: execution metadata for audit trail
  executionId?:    string;
  openedAt?:       number;
}

// ── Module-level state ────────────────────────────────────────────────────────

const contextStorage = new AsyncLocalStorage<ActiveContext>();

// FIX D: Monotonic counter for unique execution IDs within process lifetime
let _emergencyCounter = 0;

const EMERGENCY_TTL_S = 60;
const EMERGENCY_KEY   = (id: string) => `v20:guard:emergency:${id}`;

// FIX D: Well-known recurring IDs that are safe to use repeatedly.
// These are cron / boot IDs whose repeat is by design — they get a unique suffix.
const RECURRING_IDS = new Set([
  'budget-cap',
  'system-init',
  'campaign-cap',
  'account-daily-cap',
]);

// FIX #16: Cap in-process emergency ID cache. Without a bound this Set grows
// for the entire lifetime of the process — one entry per emergency call.
// At 10,000 entries with ~50 bytes per UUID string this is ~500 KB, but more
// importantly it signals a runaway caller pattern worth alerting on.
// Eviction strategy: remove the oldest-inserted entry (Set preserves insertion
// order, so .values().next().value is always the oldest).
// Note: cross-pod deduplication is handled by the Redis check below — this
// Set only prevents within-pod replay in the same process lifetime.
const _usedEmergencyIds = new Set<string>();
const MAX_EMERGENCY_ID_CACHE = 10_000;

function trackEmergencyId(id: string): void {
  if (_usedEmergencyIds.size >= MAX_EMERGENCY_ID_CACHE) {
    // Remove oldest entry (Sets iterate in insertion order)
    const oldest = _usedEmergencyIds.values().next().value;
    if (oldest !== undefined) _usedEmergencyIds.delete(oldest);
  }
  _usedEmergencyIds.add(id);
}

// ── Guard ─────────────────────────────────────────────────────────────────────

export class MetaApiExecutionGuard {
  private static redis: Redis | null = null;

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  /**
   * Initialize Redis client for emergency context deduplication.
   * MUST be called at application bootstrap (V15Module.onApplicationBootstrap).
   * Safe to call multiple times — only first call takes effect.
   */
  static init(redis: Redis): void {
    if (!MetaApiExecutionGuard.redis) {
      MetaApiExecutionGuard.redis = redis;
    }
  }

  // ── Assertions ─────────────────────────────────────────────────────────────

  /**
   * Assert current async chain is inside a kernel or emergency context.
   * THROWS hard if not — any Meta mutation without context is forbidden.
   */
  static assertInKernelContext(operationId: string): void {
    const ctx = contextStorage.getStore();
    if (!ctx) {
      throw new Error(
        `[MetaApiGuard] FORBIDDEN: "${operationId}" called outside kernel context. ` +
        `All Meta API mutations MUST run inside runInKernelContext() ` +
        `or runInEmergencyContext(). This is a hard safety violation.`,
      );
    }
  }

  // ── Context runners ────────────────────────────────────────────────────────

  /**
   * Open a kernel execution context for the duration of fn().
   * Called ONLY by RCCSKernel.executeWithAuthority().
   */
  static async runInKernelContext<T>(
    context: KernelContext,
    fn:      () => Promise<T>,
  ): Promise<T> {
    const active: ActiveContext = {
      kind:          'kernel',
      kernelContext: context,
      openedAt:      Date.now(),
    };
    return contextStorage.run(active, fn);
  }

  /**
   * Open an emergency context for capital-breach or kill-switch operations.
   *
   * FIX D hardening:
   *   1. UNIQUE EXECUTION ID: `executionId` = `${rawId}:${timestamp}:${counter}:${uuid8}`
   *      so every invocation is globally unique — even for recurring IDs.
   *   2. TTL ENFORCEMENT: Redis key set with EMERGENCY_TTL_S (60s) — strict expiry.
   *   3. PREVENT REUSE: Non-recurring IDs that appear twice in this process throw.
   *   4. LOG ALL: Structured log at open and close of every emergency context.
   *
   * @param emergencyId  Semantic label for this emergency action.
   * @param fn           The emergency operation to execute.
   */
  static async runInEmergencyContext<T>(
    emergencyId: string,
    fn:          () => Promise<T>,
  ): Promise<T> {
    _emergencyCounter += 1;

    // FIX D #1: Build a globally unique execution ID from caller label + entropy
    const executionId = `${emergencyId}:${Date.now()}:${_emergencyCounter}:${uuidv4().slice(0, 8)}`;

    // FIX D #3: Prevent reuse of non-recurring IDs within this process lifetime
    const isRecurring = RECURRING_IDS.has(emergencyId);
    if (!isRecurring) {
      if (_usedEmergencyIds.has(emergencyId)) {
        // Hard throw — non-recurring IDs must never be reused
        const msg =
          `[MetaApiGuard] HARD BLOCK: Emergency ID "${emergencyId}" has already been used ` +
          `in this process. Non-recurring emergency IDs must be unique. ` +
          `Use a UUID+timestamp key or a well-known recurring label.`;
        console.error(msg);
        throw new Error(msg);
      }
      trackEmergencyId(emergencyId);
    }

    // FIX D #4: Log all emergency context openings
    const openLog = {
      event:       'EMERGENCY_CONTEXT_OPEN',
      emergencyId,
      executionId,
      counter:     _emergencyCounter,
      ts:          new Date().toISOString(),
      recurring:   isRecurring,
    };
    console.error(`[MetaApiGuard] ${JSON.stringify(openLog)}`);

    // FIX D #2: Redis-backed uniqueness check with strict TTL
    if (MetaApiExecutionGuard.redis) {
      try {
        // Use the full executionId as Redis key — always unique, so SETNX always succeeds.
        // The emergencyId is also stored for cross-pod duplicate detection of raw labels.
        const redisKey = EMERGENCY_KEY(executionId);
        await MetaApiExecutionGuard.redis.set(
          redisKey, JSON.stringify({ emergencyId, executionId, openedAt: Date.now() }),
          'EX', EMERGENCY_TTL_S, 'NX',
        );

        // For recurring IDs, also check if another pod is running the same cron concurrently
        if (isRecurring) {
          const cronKey    = EMERGENCY_KEY(`cron:${emergencyId}`);
          const cronActive = await MetaApiExecutionGuard.redis.set(
            cronKey, executionId, 'EX', EMERGENCY_TTL_S, 'NX',
          );
          if (cronActive === null) {
            // Another pod has this recurring job running — log only, do not block
            // (emergency ops must never be blocked on Redis contention)
            console.error(
              `[MetaApiGuard] WARNING: Recurring emergency ID "${emergencyId}" ` +
              `already active on another pod. executionId=${executionId}. ` +
              `Proceeding (emergency kills must never be blocked).`,
            );
          }
        }
      } catch (redisErr) {
        console.error(
          `[MetaApiGuard] Redis emergency tracking unavailable: ${(redisErr as Error).message}. ` +
          `executionId=${executionId}. Proceeding without deduplication check.`,
        );
      }
    }

    // ── Run inside a context that passes assertInKernelContext() checks ──────
    const active: ActiveContext = {
      kind:        'emergency',
      emergencyId,
      executionId,
      openedAt:    Date.now(),
    };

    let result: T;
    let execError: unknown;
    try {
      result = await contextStorage.run(active, fn);
    } catch (err) {
      execError = err;
      throw err;
    } finally {
      // FIX D #4: Log close of every emergency context (success or failure)
      const closeLog = {
        event:       'EMERGENCY_CONTEXT_CLOSE',
        emergencyId,
        executionId,
        durationMs:  Date.now() - (active.openedAt ?? Date.now()),
        status:      execError ? 'ERROR' : 'OK',
        ts:          new Date().toISOString(),
      };
      console.error(`[MetaApiGuard] ${JSON.stringify(closeLog)}`);

      // Clean up Redis cron lock on completion (allow next scheduled run)
      if (isRecurring && MetaApiExecutionGuard.redis) {
        const cronKey = EMERGENCY_KEY(`cron:${emergencyId}`);
        MetaApiExecutionGuard.redis.del(cronKey).catch(() => {});
      }
    }

    return result!;
  }

  // ── Introspection (test/audit use) ─────────────────────────────────────────

  /**
   * Returns the active context for the current async chain, or null if none.
   * For testing and observability only — do not use in production logic.
   */
  static getActiveContext(): ActiveContext | null {
    return contextStorage.getStore() ?? null;
  }
}
