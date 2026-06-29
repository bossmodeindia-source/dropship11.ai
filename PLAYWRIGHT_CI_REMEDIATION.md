# Playwright CI Remediation

## Summary

Fixed the Playwright CI failures without skipping tests, weakening assertions, bypassing auth globally, or removing coverage.

## Root cause

The affected pages existed and the expected UI text was still valid. The CI-only failures were caused by production-mode frontend behavior:

1. The login page could submit as plain static HTML before React hydration, leaving the browser at `/?` instead of navigating to `/dashboard`.
2. The production Content Security Policy blocked Next.js hydration bootstrap scripts because it used a static `script-src` without a request nonce.
3. The failure-scenario test armed a one-shot `/dashboard/summary` outage before the dashboard's own initial summary request had completed, so the page request could consume the injected failure before the explicit retry-flow assertion.

## Fixes applied

- Added a hydration-safe login submit state so the submit button is disabled until the client has mounted.
- Replaced the static frontend CSP with a per-request nonce CSP in Next middleware.
- Forced the frontend app shell to dynamic rendering so Next can apply the per-request nonce to scripts.
- Kept the expected certification UI text intact:
  - `Welcome back, Ava`
  - `Invalid credentials`
  - `Admin Panel`
  - `Orders`
  - `Integrations`
  - `AI Campaigns`
- Made the Playwright web server command derive its port from `PLAYWRIGHT_BASE_URL`.
- Updated the failure-scenario test to wait for the dashboard's initial summary request before injecting the simulated Redis outage.

## Verification

### Backend build

Command:

```bash
npm run build
```

Result:

- Passed.
- Architecture Guard passed.
- Production Gate passed `20/20`.

### Frontend production build

Command:

```bash
npm run build --prefix frontend
```

Result:

- Passed.
- Frontend routes are now dynamic server-rendered routes with middleware active.

### Playwright

Command used locally with the installed Chromium executable:

```powershell
$env:CI="1"
$env:PLAYWRIGHT_BASE_URL="http://127.0.0.1:3106"
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE="$env:LOCALAPPDATA\ms-playwright\chromium-1228\chrome-win64\chrome.exe"
npx playwright test --reporter=list
```

Observed result:

- `17/17` Playwright tests reached `ok`.
- Original CI failures were remediated.
- On this Windows workspace, the shell command timed out after the tests completed because the spawned Next production server remained attached to the process. The assertion suite itself completed successfully.

## Files changed

- `frontend/src/app/page.tsx`
- `frontend/src/app/layout.tsx`
- `frontend/src/middleware.ts`
- `frontend/next.config.mjs`
- `playwright.config.ts`
- `tests/playwright/failure-security.spec.ts`

## Certification posture

- No tests skipped.
- No flaky markers added.
- No assertions weakened.
- No auth bypass added.
- No coverage thresholds changed.
- Security scans and certification gates remain intact.
