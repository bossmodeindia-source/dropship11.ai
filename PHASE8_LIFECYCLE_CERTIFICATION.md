# Phase 8 — Jest Lifecycle Certification

Date: 2026-06-20

## Certification outcome

The post-summary Jest process hang is eliminated.

Final command:

```text
npm test -- --runInBand --detectOpenHandles
```

Final result:

- Process exit: natural, exit code 0
- Shell duration: 180.3 seconds
- Jest duration: 175.56 seconds
- Test suites: 74 passed, 74 total
- Tests: 901 passed, 901 total
- Open-handle diagnostics: none
- `--forceExit`: not used

Final evidence: `phase8-jest-final.log`

## Before and after

| Lifecycle result | Before | After |
| --- | --- | --- |
| Suites | 74 passed | 74 passed |
| Tests | 899 passed | 901 passed |
| Post-summary process | Remained alive until timeout | Exited naturally |
| Open-handle report | No useful timer diagnostics from Jest | No remaining open handles |
| Force exit | Not used | Not used |

The final test count increased by two because explicit shutdown assertions were added for the retry queue and cache resource owners.

## Root causes

### 1. Shopify webhook controller test modules

`shopify-webhook-v60.controller.spec.ts` compiled a new Nest testing module before every test but did not close it. The controller's `RedisHealthGuard` is enhancer metadata, so providing a guard-shaped value in the providers list did not override the enhancer. Nest constructed a real guard for each test, leaving one referenced 10-second Redis probe interval per module.

Resolution:

- Override `RedisHealthGuard` with `overrideGuard(...)`.
- Retain each compiled `TestingModule`.
- Close it in `afterEach`.

### 2. Failsafe timeout races

`FailSafeService` used uncancelled 5-second timeout promises in `Promise.race` for Redis and PostgreSQL probes. Successful dependency responses left their losing timeout branches referenced until expiration.

Resolution:

- Centralized the race in a `withTimeout` helper.
- Clear the timeout in `finally` on success, failure, or timeout.

### 3. Circuit-breaker timeout test

The Shopify circuit-breaker timeout test intentionally created a one-second slow-operation timer. The circuit breaker rejected first, leaving the test timer alive.

Resolution:

- Retain and clear the test-owned timer in `finally` without weakening the timeout assertion.

### 4. Unowned Redis/BullMQ resources

Two core services owned long-lived infrastructure without shutdown contracts:

- `RetryQueueService`: BullMQ queue, dynamically registered workers, and ioredis connection.
- `CacheService`: ioredis connection and error event listener.

Resolution:

- Added `OnModuleDestroy` to both services.
- Close retry workers, queue, and Redis connection.
- Remove the cache error listener and close/disconnect Redis according to connection state.
- Added explicit lifecycle assertions.

## Resource inventory

The Phase 8 audit covered these long-lived resource classes:

- `setInterval`: audit flushing, Redis health probing, failsafe checks, recovery scanning, and currency refresh.
- `setTimeout`: dependency timeouts, API retries, circuit-breaker deadlines, financial failsafe aborts, and test-owned delay timers.
- Cron jobs and scheduler services: Nest Schedule jobs across outbox, commerce, ads, recovery, organic, finance, SEO, retention, and optimization modules.
- BullMQ: application queues, order/DLQ workers, platform-ad workers, bot workers, retry workers, and dynamically registered retry processors.
- QueueEvents: bot execution and priority event streams.
- Redis: health probes, distributed locks, cache clients, retry queue connections, and Nest Redis clients.
- Telemetry: OpenTelemetry SDK/exporter is disabled in Jest through `OTEL_SDK_DISABLED`; production signal shutdown remains unchanged.
- Event emitters: Redis error listeners, BullMQ worker listeners, QueueEvents listeners, and circuit-breaker listeners.

Existing correct ownership was verified for audit, recovery, distributed locks, order queues/workers, platform-ad workers, bot queues/workers/QueueEvents, and Nest-managed scheduler jobs. Test applications close through `app.close()`.

## Verification

- `npx tsc --noEmit --pretty false` — passed.
- Focused lifecycle suites — 23/23 passed and terminated naturally.
- App-boot and timeout-sensitive suites — 54/54 passed and terminated naturally.
- Shopify webhook controller suite — 14/14 passed and terminated naturally.
- Full exact Jest command — 74/74 suites and 901/901 tests passed, no open handles, natural exit code 0.

## Files changed

- `src/__tests__/unit/shopify-webhook-v60.controller.spec.ts`
- `src/__tests__/unit/shopify-circuit-breaker.spec.ts`
- `src/core/__tests__/ops-reasoning-supply-phase1.spec.ts`
- `src/core/ops/cache.service.ts`
- `src/core/ops/retry.queue.ts`
- `src/failsafe/failsafe.service.ts`
- `PHASE8_LIFECYCLE_CERTIFICATION.md`

Temporary timer/handle diagnostic helpers were removed after diagnosis. GitHub Actions was not modified.
