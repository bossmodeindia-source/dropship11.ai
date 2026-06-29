# Phase 6 Jest Failure Inventory

## Baseline

- Handoff count: **23 failed suites**.
- Reproduced Phase 6 baseline (2026-06-19): **20 failed, 54 passed, 74 total**.
- Baseline tests: **106 failed, 765 passed, 871 total**.
- Command: `npm test -- --runInBand --detectOpenHandles`.
- Evidence: `phase6-jest-baseline.log`.

The repository had already moved from 23 to 20 failures before this Phase 6 run. The three suites absent from the reproduced baseline cannot be named reliably from the current workspace, so this report does not invent them.

## Reproduced failed suites

1. `src/withdrawal/__tests__/withdrawal.service.spec.ts` — dependency/test harness drift.
2. `src/__tests__/e2e/v67-commerce-expanded.e2e.spec.ts` — Shopify webhook route/HMAC contract drift.
3. `src/shopify/__tests__/shopify.service.spec.ts` — missing encryption dependency in test module.
4. `src/user-business-connections/__tests__/user-business-connections.service.spec.ts` — stale persistence result contract.
5. `src/products/__tests__/products.service.spec.ts` — stale Drizzle chain mock.
6. `src/__tests__/unit/shopify-webhook-v60.controller.spec.ts` — webhook constructor/HMAC contract drift.
7. `src/withdrawal/__tests__/withdrawal.e2e.spec.ts` — dependency/test harness drift.
8. `src/__tests__/e2e/commerce-flow.e2e.spec.ts` — Shopify webhook route/HMAC contract drift.
9. `src/__tests__/unit/pipeline-drizzle-migration.spec.ts` — deleted Thompson Sampling methods.
10. `src/meta-ads/performance/__tests__/meta-performance.service.spec.ts` — stale service contract.
11. `src/meta-ads/performance/__tests__/contract/meta-api.contract.spec.ts` — stale service contract.
12. `src/ad-creatives/__tests__/creative-generator.service.spec.ts` — AI provider result contract drift.
13. `src/common/testing/__tests__/security/auth-security.spec.ts` — rate-limit constructor/behavior drift.
14. `src/tenant/__tests__/tenant-isolation.spec.ts` — whitespace tenant validation gap.
15. `src/__tests__/unit/single-orchestrator.spec.ts` — stale source-layout assumptions.
16. `src/__tests__/unit/arch-guard.spec.ts` — Unix-only source scanning assumption.
17. `src/orders/__tests__/orders.service.spec.ts` — stale Drizzle chain mock.
18. `src/common/middleware/__tests__/rate-limit.middleware.spec.ts` — rate-limit constructor/behavior drift.
19. `src/escrow/__tests__/escrow-transaction.service.spec.ts` — selected-column alias drift.
20. `src/products/engines/__tests__/scoring.engine.spec.ts` — stale clamp expectation.

## Open handle detected

One `HTTPINCOMINGMESSAGE` handle originated from `NotificationsService.forwardWebhook()` during `notifications.service.spec.ts`.
