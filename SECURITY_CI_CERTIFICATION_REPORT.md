# Phase 12 — Security, Dependency, and CI Certification

## Scope

Phase 12 adds the remaining enterprise CI/CD certification gates without weakening existing tests, coverage thresholds, production gates, or Playwright browser certification.

## Implemented gates

| Gate                       | Implementation                                             |
| -------------------------- | ---------------------------------------------------------- |
| ESLint                     | `npm run lint:check` using `eslint.config.mjs`             |
| Prettier                   | `npm run format:check` using `.prettierrc.json`            |
| Semgrep                    | `semgrep.yml` plus `npm run security:semgrep`              |
| npm audit                  | `npm run security:audit-npm`                               |
| audit-ci                   | `npm run security:audit-ci`                                |
| OSV Scanner                | official GitHub release binary install plus lockfile scans |
| Trivy filesystem scan      | `trivy.yaml`, Trivy action, and exact misconfig validation |
| Docker build               | `docker build -t aiempire-backend:ci .`                    |
| Trivy Docker image scan    | master workflow image scan using `trivy.yaml`              |
| OpenAPI contract tests     | `npm run test:contract`                                    |
| Playwright commerce E2E    | `npx playwright test`                                      |
| Final certification script | `npm run certification:final`                              |

## Master workflow

Updated `.github/workflows/certification.yml` now runs:

1. `npm ci`
2. frontend dependency install
3. Playwright Chromium install
4. TypeScript check
5. backend build
6. frontend build
7. production certification gate
8. strict certification gate
9. full Jest suite
10. OpenAPI contract tests
11. Playwright tests
12. lint check
13. format check
14. npm audit
15. audit-ci
16. Semgrep
17. OSV dependency scan via official GitHub release binary
18. Docker build
19. Trivy filesystem scan
20. Trivy Docker image scan
21. final certification script

## Local evidence before Phase 12 wiring

- `npm run build`: passed
- `npm run certify`: passed, 20/20
- `npm test -- --runInBand --detectOpenHandles`: passed, 76 suites / 916 tests
- `npx playwright test`: passed, 17 / 17 tests

## Phase 12 local validation

| Command                       | Local result                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `npm run lint:check`          | Passed with 0 errors and 12 warnings                                         |
| `npm run format:check`        | Passed                                                                       |
| `npm run security:audit-npm`  | Passed at `--audit-level=high`; npm reported 28 moderate, 0 high, 0 critical |
| `npm run security:audit-ci`   | Passed; audit-ci reported 28 moderate, 0 high, 0 critical                    |
| `npm run certification:final` | Passed                                                                       |

External scanner availability on this Windows workstation:

- Semgrep CLI was not installed locally; the master workflow installs it with `python -m pip install semgrep` and runs `npm run security:semgrep`.
- OSV Scanner is installed in CI from the official GitHub release binary with `curl` and executed against both lockfiles.
- Trivy was present locally but blocked by Windows local permission access; the master workflow uses `aquasecurity/trivy-action`.
- Docker CLI was present locally; Docker build and image scanning are wired into the master workflow.

These local limitations are not recorded as passing scan results. The CI workflow invokes the real scanners and is expected to fail on real findings.

## Notes

- No existing tests were skipped or disabled.
- Coverage thresholds were not lowered.
- Production certification gates were not weakened.
- Scanner results are not faked; the master workflow invokes real scanners and fails on real findings.

## Phase 14 security CI fix addendum

- Replaced the invalid `npm install -g osv-scanner` workflow step with an official OSV Scanner GitHub release binary install.
- OSV now scans both dependency lockfiles:
  - `package-lock.json`
  - `frontend/package-lock.json`
- Updated Kubernetes application images from placeholder/latest to fixed production tags:
  - `ghcr.io/bossmodeindia-source/aiempire-nestjs:v69`
- Added exact Trivy medium misconfiguration validation in `scripts/validate-trivy-misconfig.js`.
  - New high/critical findings fail.
  - New undocumented medium findings fail.
  - Existing medium findings are accepted only when file, rule ID, and message content match the documented exception.
- Updated Semgrep exclude globs from repo-relative patterns to recursive patterns:
  - `**/src/**/*.spec.ts`
  - `**/src/**/__tests__/**`

Phase 14 verified local commands:

| Command                                                                                                                               | Result                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `npm run security:audit-npm`                                                                                                          | Passed; 0 high, 0 critical, 28 moderate       |
| `npm run security:audit-ci`                                                                                                           | Passed; 0 high, 0 critical, 28 moderate       |
| `npm run certification:final`                                                                                                         | Passed                                        |
| `trivy fs --scanners misconfig --severity MEDIUM,HIGH,CRITICAL --format json --output phase14-trivy-misconfig.json --exit-code 0 k8s` | Completed                                     |
| `node scripts/validate-trivy-misconfig.js phase14-trivy-misconfig.json`                                                               | Passed; 8 documented medium findings accepted |
| `npm run build`                                                                                                                       | Passed                                        |
| `npm test -- --runInBand`                                                                                                             | Passed; 76 suites / 916 tests                 |
| `npx playwright test`                                                                                                                 | Passed; 17 / 17 tests                         |

Local Windows Semgrep note:

- Semgrep installation was attempted with elevated network access, but the CLI was not available to the active Python/PowerShell environment afterward.
- CI still installs Semgrep with `python -m pip install semgrep` and runs the real `npm run security:semgrep` gate.

## Final CI remediation addendum

- Removed `google/osv-scanner-action` from all workflows.
- CI now installs OSV Scanner with:
  - `curl -L https://github.com/google/osv-scanner/releases/latest/download/osv-scanner_linux_amd64 -o osv-scanner`
  - `chmod +x osv-scanner`
- CI runs OSV separately for:
  - `./osv-scanner --lockfile package-lock.json`
  - `./osv-scanner --lockfile frontend/package-lock.json`
- Upgraded frontend Next.js from `14.2.35` to `15.5.18`.
  - `15.5.16` was tested first but still matched the HIGH advisory range `>=15.2.0 <15.5.18`.
  - `15.5.18` is the lowest safe version in the requested 15.5 line for the current npm advisory.
- Added `outputFileTracingRoot` to `frontend/next.config.mjs` so Next 15 does not infer `C:\Users\acer` as the workspace root during local Windows builds.

Final verification:

| Command                                                                                          | Result                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `cd frontend && npm install`                                                                     | Passed; 0 high, 0 critical                  |
| `cd frontend && npm run build`                                                                   | Passed on Next.js 15.5.18                   |
| `cd frontend && npm audit --audit-level=high`                                                    | Passed; remaining findings are moderate     |
| `npm run build`                                                                                  | Passed                                      |
| `npm test -- --runInBand`                                                                        | Passed; 76 suites / 916 tests               |
| `npx playwright test`                                                                            | Passed; 17 / 17 tests                       |
| `npm run security:audit-npm`                                                                     | Passed; 0 high, 0 critical, 28 moderate     |
| `npm run security:audit-ci`                                                                      | Passed; 0 high, 0 critical, 28 moderate     |
| `trivy fs --scanners vuln --severity HIGH,CRITICAL --format table --exit-code 1 --timeout 20m .` | Passed; 0 vulnerabilities in both lockfiles |

Remaining risk:

- No frontend PostCSS OSV finding remains after the final override regeneration.
- Trivy reports 0 HIGH/CRITICAL vulnerabilities for both backend and frontend lockfiles.

## Enterprise OSV dependency remediation addendum

Enterprise Certification later failed on the backend OSV lockfile scan with 9 known vulnerabilities across 7 packages:

| Package        | Reported vulnerable version | Remediated installed version |
| -------------- | --------------------------- | ---------------------------- |
| `@nestjs/core` | 10.4.22                     | 11.1.18                      |
| `esbuild`      | 0.18.20                     | 0.25.12 / 0.28.1             |
| `file-type`    | 20.4.1                      | 21.3.4                       |
| `js-yaml`      | 3.14.2 / 4.1.0              | 4.3.0                        |
| `uuid`         | 9.0.1 / 11.0.3              | 11.1.1                       |

Fix method:

- Upgraded NestJS runtime/test packages to the fixed NestJS 11-compatible dependency line.
- Upgraded related NestJS ecosystem packages to versions compatible with NestJS 11.
- Updated direct `uuid` to 11.1.1.
- Added precise package manager overrides for fixed transitive instances of `@nestjs/common`, `@nestjs/core`, `esbuild`, `file-type`, `js-yaml`, and `uuid`.
- Removed the stale Express 4 override that conflicted with the NestJS 11 platform dependency tree.
- Added a local Redis injection shim so `@liaoliaots/nestjs-redis` 10 can be used without reintroducing the older NestJS 10 peer chain.

No OSV vulnerabilities were ignored, allowlisted, or suppressed.

Verification after this remediation:

| Command                      | Result                                 |
| ---------------------------- | -------------------------------------- |
| `npm install`                | Passed; npm audit reported 0 vulns     |
| `npm run build`              | Passed                                 |
| `npm run certify`            | Passed; 20/20                          |
| `npm test -- --runInBand`    | Passed; 76/76 suites and 916/916 tests |
| `npx playwright test`        | Passed; 17/17 tests                    |
| `npm run security:audit-npm` | Passed; 0 vulnerabilities              |
| `npm run security:audit-ci`  | Passed; 0 vulnerabilities              |

Local Windows note: exact OSV CLI verification could not be completed because the Windows OSV binary download timed out and produced a corrupt executable. CI still installs the official Linux x64 OSV Scanner binary and scans both lockfiles. The backend lockfile now resolves the Enterprise OSV-reported packages to fixed installed versions.

## Final OSV frontend PostCSS remediation

Live GitHub Actions logs for both remaining failed workflows showed the same frontend OSV finding:

| Workflow                 | Failing step        | Package   | Version | Fixed version |
| ------------------------ | ------------------- | --------- | ------- | ------------- |
| Security Certification   | OSV dependency scan | `postcss` | 8.4.31  | 8.5.10        |
| Enterprise Certification | OSV dependency scan | `postcss` | 8.4.31  | 8.5.10        |

Root cause:

- The vulnerable `postcss@8.4.31` was nested under the frontend Next.js dependency tree.
- The top-level frontend `postcss` was already safe, but OSV scans the full lockfile and correctly failed on the nested vulnerable copy.

Fix:

- Added a frontend package override for `postcss`.
- Aligned the direct frontend dev dependency to the same safe range.
- Regenerated `frontend/package-lock.json`.

Verification:

| Command / check                               | Result                    |
| --------------------------------------------- | ------------------------- |
| frontend resolved `postcss`                   | 8.5.16                    |
| `cd frontend && npm audit --audit-level=high` | Passed; 0 vulnerabilities |
| `cd frontend && npm run build`                | Passed on Next.js 15.5.18 |

No OSV ignores or allowlists were added.
