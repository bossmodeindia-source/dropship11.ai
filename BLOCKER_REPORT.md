# Phase 2 Blocker Report

Generated: 2026-06-16

## Commands Run

| Command | Result |
| --- | --- |
| `npm run build` | Failed in `prebuild` certification gate |
| `npm test -- --runInBand` | Failed: 44 failed suites, 30 passed suites, 78 failed tests, 553 passed tests |
| `npm run test:coverage:final -- --runInBand` | Failed: same 44 suite blockers prevent valid final coverage |
| `npm run test:integration:coverage -- --runInBand` | Failed: integration suite does not compile |
| `npx tsc --noEmit --pretty false` | Passed after safe source fixes |

## Safe Fixes Applied

- Added the missing requested npm scripts without lowering thresholds:
  - `test:coverage:final`
  - `test:integration:coverage`
- Fixed source TypeScript errors:
  - `src/core/empire/empire-brain.service.ts`: alert payloads now use `message`.
  - `src/escrow/escrow-transaction.service.ts`: escrow status event map now uses `SHIPPED`.
  - `src/telegram-storage/telegram-storage.scheduler.ts`: BullMQ repeat jobs now use `pattern`.
- Fixed safe test/mock blockers:
  - `src/ai-media/__tests__/ad-media-assets.repository.upsert.spec.ts`: corrected Drizzle UPSERT mock chain.
  - `src/products/engines/__tests__/scoring.engine.spec.ts`: composite assertion uses `trendScore`.
  - `src/products/engines/__tests__/decision.engine.spec.ts`: score fixture includes current `ScoringResult` fields.
  - `src/orders/__tests__/orders.service.spec.ts`: removed recursive mock type annotation.
  - `src/workers/__tests__/order.processor.spec.ts`: removed recursive mock type annotation.
  - `src/admin/__tests__/admin-users.service.spec.ts`: aligned calls with current service signatures.
- Fixed a safe runtime compatibility issue:
  - `src/supplier/supplier.service.ts`: normalizes `opossum` default export shape before constructing the circuit breaker.

## TypeScript Errors

Source TypeScript now passes with `npx tsc --noEmit --pretty false`.

Remaining TypeScript blockers are test and integration contracts that do not match current service APIs:

- `src/financial/__tests__/profit.service.spec.ts`
  - Expects removed or renamed `ProfitService.calculateNetProfit`.
  - Expects removed or renamed `ProfitService.calculateBreakevenRoas`.
- `src/commission/__tests__/commission.service.spec.ts`
  - Expects removed or renamed `CommissionService.calculatePriceFloor`.
  - Expects removed or renamed `CommissionService.getAdminConfig`.
- `src/audit/__tests__/audit.service.spec.ts`
  - Expects removed or renamed `AuditService.logPlanChange`.
- `src/creative-virality/__tests__/creative-scoring.service.spec.ts`
  - Calls `selectWinningVariant` with one argument; current service requires two.
- `src/ai-media/__tests__/ai-media.service.spec.ts`
  - Calls media generation methods with old object-shaped inputs where current methods expect strings or camelCase DTO fields.
  - Expects object responses from methods that currently return strings.
- `src/ai-bot/__tests__/bot-mode.service.spec.ts`
  - Expects `mode` and `latencyMs` fields not present in current return type.
  - Contains references to an undefined `service` variable.
- `src/supplier-payment/__tests__/supplier-payment.service.spec.ts`
  - Expects older methods such as `markFailed` and `markCompleted`.
  - Calls `initiatePayment` with an old object payload instead of the current argument list.

## Broken Imports

- `src/escrow/__tests__/escrow-transaction.service.spec.ts`
  - Imports `./escrow-transaction.service` from inside `__tests__`, which resolves to a missing file.
  - Imports `../audit/audit.service`, `../alerting/alerting.service`, `../common/outbox/outbox.service`, `../common/database/database.module`, and `../common/events/domain-events` from the wrong relative depth.
- `src/__tests__/integration/commerce-pipeline.integration.spec.ts`
  - Imports missing `../../escrow/escrow.service`.
  - Imports missing `../../common/reconciliation/reconciliation.service`.
- `src/__tests__/unit/outbox.service.spec.ts`
  - Imports missing `../../outbox/outbox.service`; actual outbox implementation is under `src/common/outbox/outbox.service.ts`.

## Failing Jest Tests

The full Jest run currently reports:

- Test suites: 44 failed, 30 passed, 74 total.
- Tests: 78 failed, 553 passed, 631 total.

Major failing areas observed:

- `ai-bot`
- `ai-media`
- `audit`
- `commission`
- `creative-virality`
- `escrow`
- `financial`
- `outbox`
- `supplier-payment`
- Integration commerce pipeline

Several additional suites run and fail at runtime after compiling. Those should be reviewed after the compile-time test contract blockers above are resolved, because many failures are cascading.

## Integration Failures

`npm run test:integration:coverage -- --runInBand` fails before executing any tests:

- `src/__tests__/integration/commerce-pipeline.integration.spec.ts` cannot compile.
- Missing services:
  - `../../escrow/escrow.service`
  - `../../common/reconciliation/reconciliation.service`
- Outbox API mismatch:
  - Test expects `publishWithinTx`.
  - Current `OutboxService` exposes a different API.
- Commission API mismatch:
  - Test expects `computeAndLock` and `getLockedCommission`.
- Supplier payment API mismatch:
  - Test expects `initiateForOrder`.
- Orders API mismatch:
  - Test expects `markFulfilled`.
- Order schema mismatch:
  - Test expects `returnStatus`.

## Mock Failures

- Fixed: `src/ai-media/__tests__/ad-media-assets.repository.upsert.spec.ts` had an invalid Drizzle chain mock that caused rejected UPSERT paths to fail incorrectly.
- Remaining likely mock drift:
  - `src/ai-media/__tests__/ai-media.service.spec.ts` mocks old response shapes and old snake_case request fields.
  - `src/supplier-payment/__tests__/supplier-payment.service.spec.ts` lacks the current dependency and method contract.
  - Integration commerce pipeline mocks old outbox, commission, supplier payment, and order service methods.

## Coverage Blockers

Final coverage is blocked by failing suites, so the global final percentage is not certifiable.

Current coverage threshold settings remain unchanged:

- Global statements: 80%.
- Global branches: 80%.
- Global functions: 80%.
- Global lines: 80%.
- `./src/escrow/` lines: 95%.
- `./src/commission/` lines: 95%.
- `./src/orders/` lines: 90%.
- `./src/finance/` lines: 90%.
- `./src/auth/` lines: 85%.

Integration coverage reports 0% because the integration suite does not compile and no tests execute.

## Architecture Violations

`npm run build` fails in `prebuild`.

Architecture guardrails pass:

- ARCH-001 through ARCH-006 all pass.

Production gate fails 4 of 20 checks:

- Legacy ShopifyWebhookController V59 file still exists: `src/shopify/shopify-webhook.controller.ts`.
- `ShopifyWebhookV60Controller` is not the sole active Shopify webhook controller.
- Outbox pattern gate cannot find required `writeWithOutbox` and `enqueueInTx` implementation at the expected location/API.
- `SHOPIFY_WEBHOOK_SECRET` only gate cannot verify V60 controller because V60 controller is not found.

Additional environment blocker:

- The certification output emits repeated Windows portability errors: `grep` is not recognized. Some verification scripts assume Unix shell tools.

## Safe Fix Boundary

The remaining blockers are not safe one-line repairs. They require product/API decisions:

- Whether to restore legacy method aliases or rewrite tests to current APIs.
- Whether to move or alias outbox under `src/outbox`.
- Whether Shopify V59 should be deleted, migrated, or replaced by V60 module wiring.
- Whether missing escrow and reconciliation services should be restored or the integration suite rewritten.

