# Phase 6B Test Reduction Report

## Outcome

Phase 6B succeeded.

| Measurement | Before | After |
|---|---:|---:|
| Failed Jest suites | 20 | 5 |
| Passed Jest suites | 54 | 69 |
| Total Jest suites | 74 | 74 |
| Failed tests | 106 | 61 |
| Passed tests | 765 | 838 |
| Total tests | 871 | 899 |

The failed-suite target was **under 10**. The final count is **5**.

Baseline evidence: `phase6-jest-baseline.log` and `JEST_REMAINING_FAILURES.md`.
Final evidence: `phase6b-jest-after.log`.

## Targeted suite result

All ten Phase 6B target suites pass together:

- **10 passed, 0 failed suites**
- **147 passed, 0 failed tests**

The ten passing suites are:

1. `src/shopify/__tests__/shopify.service.spec.ts`
2. `src/user-business-connections/__tests__/user-business-connections.service.spec.ts`
3. `src/products/__tests__/products.service.spec.ts`
4. `src/__tests__/unit/shopify-webhook-v60.controller.spec.ts`
5. `src/__tests__/unit/pipeline-drizzle-migration.spec.ts`
6. `src/meta-ads/performance/__tests__/meta-performance.service.spec.ts`
7. `src/meta-ads/performance/__tests__/contract/meta-api.contract.spec.ts`
8. `src/ad-creatives/__tests__/creative-generator.service.spec.ts`
9. `src/orders/__tests__/orders.service.spec.ts`
10. `src/escrow/__tests__/escrow-transaction.service.spec.ts`

## Fixes made

- Added the current encryption dependency to the Shopify API key test module.
- Updated user business connection tests for the current upsert contract and encrypted column names.
- Corrected Products, Orders, and Escrow Drizzle chain/result mocks.
- Replaced the Shopify webhook test's retired Redis/idempotency wiring with the current `WebhookIdempotencyService`, outbox, audit, and database dependencies.
- Updated Thompson Sampling tests to use `updateDistributions()` and `runRound()`; corrected the runtime enum import and made fire-and-forget Drizzle updates safe for promise-like query builders.
- Restored current Meta performance evaluation behavior for ROAS classification, scale/pause decisions, assumed-AOV ROAS calculation, and neutral fallback metrics.
- Updated the Meta mock-mode persistence expectation and supplied `ConfigService` in the recreated test module.
- Updated the creative provider fallback mock to return the current `{ bundle, aiGenerated, model }` contract.

No tests or suites were skipped or disabled. Coverage thresholds were not changed.

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit --pretty false` | PASS |
| `npm run build` | PASS |
| Architecture Guard (build precheck) | PASS |
| `npm run certify` | PASS — 20/20 |
| Ten targeted suites | PASS — 10/10 suites, 147/147 tests |
| Full Jest with `--detectOpenHandles` | Target met — 5 failed, 69 passed |

The full open-handle run produced its complete Jest summary but did not terminate afterward and was eventually timed out. The existing asynchronous-handle issue therefore remains; it was outside the Phase 6B suite scope and was not hidden with a configuration change.

## Remaining failed suites (out of scope)

1. `src/withdrawal/__tests__/withdrawal.service.spec.ts`
2. `src/__tests__/e2e/v67-commerce-expanded.e2e.spec.ts`
3. `src/withdrawal/__tests__/withdrawal.e2e.spec.ts`
4. `src/__tests__/e2e/commerce-flow.e2e.spec.ts`
5. `src/__tests__/unit/single-orchestrator.spec.ts`

## Files changed for the ten target suites

- `src/shopify/__tests__/shopify.service.spec.ts`
- `src/user-business-connections/__tests__/user-business-connections.service.spec.ts`
- `src/products/__tests__/products.service.spec.ts`
- `src/__tests__/unit/shopify-webhook-v60.controller.spec.ts`
- `src/__tests__/unit/pipeline-drizzle-migration.spec.ts`
- `src/pipeline/modules/bandit/thompson-sampling.service.ts`
- `src/meta-ads/performance/meta-performance.service.ts`
- `src/meta-ads/performance/__tests__/meta-performance.service.spec.ts`
- `src/ad-creatives/__tests__/creative-generator.service.spec.ts`
- `src/orders/__tests__/orders.service.spec.ts`
- `src/escrow/__tests__/escrow-transaction.service.spec.ts`
- `PHASE6B_TEST_REDUCTION_REPORT.md`
