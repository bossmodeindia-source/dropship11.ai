# Phase 11 — Playwright Commerce E2E Certification

## Certification scope

- Browser framework: `@playwright/test`
- Browser project: Chromium
- Frontend under test: Next.js application in `frontend/`
- Backend behavior: deterministic browser-origin API fixtures for commerce, withdrawal, failure, and security flows
- Production business logic changes: none

## Tests created

| Area              | Coverage                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Authentication    | login, logout, invalid credentials, session persistence                                      |
| Admin dashboard   | dashboard load, metrics visibility, user management table                                    |
| User dashboard    | dashboard load, metrics visibility, subscription status, profile update API contract         |
| Shopify           | integration status, connect store, disconnect store, invalid credentials                     |
| Campaigns         | list, create, edit, pause, delete                                                            |
| Commerce flow     | create order, Shopify webhook processing, escrow creation, supplier routing, tracking update |
| Withdrawal flow   | request withdrawal, approval path, rejection path                                            |
| Failure scenarios | Redis unavailable, supplier unavailable, payment unavailable, retry flow                     |
| Security          | unauthorized route redirect, tenant isolation, CSRF enforcement, XSS-safe error rendering    |

## Execution results

| Command                                       | Status | Result                                                                        |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `npm run build`                               | Passed | Architecture guard passed, production gate passed 20/20, Nest build completed |
| `npm run certify`                             | Passed | Production gate passed 20/20                                                  |
| `npm test -- --runInBand --detectOpenHandles` | Passed | 76 suites passed, 916 tests passed                                            |
| `npx playwright test`                         | Passed | 17 tests passed, 0 failed                                                     |

Local note: on this Windows workstation, Playwright was run with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` pointing to the installed Chromium binary because the default headless-shell package was not present after the browser download. CI installs Chromium through `npx playwright install --with-deps chromium`.

## Artifacts

- HTML report: `playwright-report/`
- JSON report: `playwright-report/results.json`
- Screenshots: `test-results/playwright/` — 17 PNG files generated
- Traces: `test-results/playwright/` — 17 trace ZIP files generated
- Videos: `test-results/playwright/` — 17 WebM recordings generated

## Coverage summary

- Requested Phase 11 areas covered: 9 / 9
- Browser-level UI paths covered where the frontend currently exposes screens: auth, dashboard, admin, integrations, campaigns, orders
- Browser-origin API paths covered for flows not yet represented by production UI pages: profile update, campaign mutations, Shopify connect/disconnect, commerce fulfillment chain, withdrawal approval/rejection, failure injection, tenant isolation, CSRF validation

## Final Playwright pass percentage

100% — 17 / 17 Playwright tests passed.

## Files created or modified

- `.github/workflows/playwright.yml`
- `playwright.config.ts`
- `tests/playwright/fixtures.ts`
- `tests/playwright/auth.spec.ts`
- `tests/playwright/dashboards.spec.ts`
- `tests/playwright/shopify-campaigns.spec.ts`
- `tests/playwright/commerce-withdrawal.spec.ts`
- `tests/playwright/failure-security.spec.ts`
- `PLAYWRIGHT_CERTIFICATION_REPORT.md`
- `package.json`
- `package-lock.json`
- `frontend/package-lock.json`
