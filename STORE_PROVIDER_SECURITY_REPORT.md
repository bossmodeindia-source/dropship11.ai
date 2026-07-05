# Store Provider Security Report

Date: 2026-07-05

## Summary

Implemented security hardening for Dynamic Store / Website Provider Management before merge. The store provider layer now enforces encrypted credentials, tenant-and-user ownership, credential rotation, OAuth state validation, webhook signature verification, replay protection, disabled-provider blocking, and required audit events.

## Controls Implemented

### Secrets and Credentials

- Store provider webhook secrets are encrypted at rest with AES-256-GCM.
- User store credentials are encrypted at rest as a JSON credential envelope.
- Access tokens, refresh tokens, API keys, API secrets, and webhook secrets are covered by the encrypted credential envelope.
- API responses return only safe connection metadata.
- Admin/user UI secret fields remain blank/password-only; existing plaintext secrets are never rendered.
- Added credential rotation support through `PATCH /api/v1/user/business-connections/website/:connectionId/rotate`.
- Added audit events for create/update/disable/test/connect/disconnect/rotate/webhook/publish/order-sync paths.

### Tenant Isolation

- `user_platform_connections` now includes both `tenant_id` and `user_id`.
- User store connection uniqueness is scoped by `(tenant_id, user_id, platform_id)`.
- User list/get/rotate/disconnect/runtime credential access is tenant-and-user scoped.
- Admin analytics/status surfaces metadata only, not plaintext secrets.
- Added tests for cross-user access denial.

### Webhook Security

- Added generic store webhook receiver at `POST /api/v1/store-webhooks`.
- Verifies HMAC-SHA256 signature using encrypted provider webhook secret.
- Rejects invalid signatures with `UnauthorizedException`.
- Uses `WebhookIdempotencyService` / Redis when available for replay protection.
- Adds durable webhook event rows in `platform_webhook_events`.
- Duplicate webhook events return idempotent duplicate status and do not trigger processing.
- Emits `STORE_WEBHOOK_RECEIVED`, `STORE_WEBHOOK_REJECTED`, and `ORDER_SYNCED` audit events.

### OAuth Security

- Added OAuth start/callback DTOs and service methods.
- OAuth state is signed with HMAC and includes tenant, user, provider, redirect URI, nonce, and expiry.
- Callback validates tenant, user, provider, redirect URI, and signature.
- Redirect URI is checked against provider configuration.
- Refresh tokens are stored only inside the encrypted credential envelope.
- OAuth client secrets are never returned to frontend responses.

### API Security

- Admin provider routes remain protected by `JwtAuthGuard + RolesGuard`; `admin` role requirement also permits `superadmin` through the existing role hierarchy.
- User store routes require authenticated users.
- DTOs use `class-validator`.
- Provider test, connect, rotate, and OAuth routes are rate-limited with `@Throttle`.
- Disabled/maintenance/deleted providers are blocked from connection and runtime use.

## Audit Events Covered

- `STORE_PROVIDER_CREATED`
- `STORE_PROVIDER_UPDATED`
- `STORE_PROVIDER_DISABLED`
- `STORE_CONNECTED`
- `STORE_DISCONNECTED`
- `STORE_CREDENTIAL_ROTATED`
- `STORE_WEBHOOK_RECEIVED`
- `STORE_WEBHOOK_REJECTED`
- `PRODUCT_PUBLISHED`
- `ORDER_SYNCED`

Additional operational event:

- `STORE_PROVIDER_TESTED`

## Security Tests Added

Added/updated tests in `src/user-business-connections/__tests__/user-business-connections.service.spec.ts`:

- User cannot read another user's store connection.
- User cannot use disabled provider.
- Admin/user responses do not expose plaintext secrets.
- Invalid webhook signature is rejected.
- Duplicate webhook is ignored through idempotency claim.
- OAuth state mismatch is rejected.
- Store API key is encrypted in DB write parameters.
- Product publish is blocked without a valid store connection.
- Credential rotation encrypts new credentials and emits audit log.

## Verification Results

Passed locally:

- `npx tsc --noEmit --pretty false`
- `npm run build`
- `npm run certify` — 20/20
- `npm test -- --runInBand` — 76/76 suites, 928/928 tests
- `npx playwright test` — 17/17 tests
- `npm run security:audit-npm` — 0 vulnerabilities
- `npm run security:audit-ci` — 0 high/critical vulnerabilities
- `npm run security:semgrep` — 0 findings
- `trivy fs --timeout 30m --config trivy.yaml .` — 0 vulnerabilities
- `npm run openapi:generate`

Local environment blockers:

- OSV scanner: official Windows binary downloaded, but this host rejected it as an invalid executable for the OS platform. CI should run OSV in Linux using the existing workflow binary install.
- Trivy Docker scan: blocked locally because Docker Desktop/daemon is not running (`dockerDesktopLinuxEngine` pipe missing).

## Remaining Risk

No code-level blocker remains from the implemented security controls. OSV and Trivy Docker are environment-dependent locally and should be verified by GitHub Actions after push.
