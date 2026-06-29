# Phase 14 — Security CI Fix Report

## Result

Security CI remediation is complete without disabling scanners, faking results, skipping Trivy/OSV/Semgrep, or weakening production gates.

## Fixes applied

### OSV Scanner

Replaced the invalid npm global install:

```bash
npm install -g osv-scanner
```

with the official OSV Scanner GitHub Action:

```yaml
uses: google/osv-scanner-action/osv-scanner-action@v2
with:
  scan-args: --lockfile=package-lock.json --lockfile=frontend/package-lock.json
```

Applied to:

- `.github/workflows/certification.yml`
- `.github/workflows/security.yml`

### Trivy Kubernetes findings

Fixed placeholder/latest application images:

- `k8s/api-deployment.yaml`
- `k8s/worker-deployment.yaml`

New fixed image:

```yaml
ghcr.io/bossmodeindia-source/aiempire-nestjs:v69
```

Removed:

```yaml
ghcr.io/YOUR_ORG/aiempire-nestjs:latest
```

### Trivy medium findings

Trivy medium findings are not broadly ignored. CI now runs Trivy to JSON and validates findings with `scripts/validate-trivy-misconfig.js`.

The validator fails on:

- any high finding
- any critical finding
- any undocumented medium finding
- any documented medium finding whose file/rule/message no longer matches the expected scope

Documented medium exceptions:

| File                         | Rule        | Justification                                                                     |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `k8s/api-deployment.yaml`    | `KSV-0125`  | Pinned private GHCR org image: `ghcr.io/bossmodeindia-source/aiempire-nestjs:v69` |
| `k8s/worker-deployment.yaml` | `KSV-0125`  | Pinned private GHCR org image: `ghcr.io/bossmodeindia-source/aiempire-nestjs:v69` |
| `k8s/configmap.yaml`         | `KSV-01010` | `PORT` and `THROTTLE_LIMIT` are non-sensitive runtime tuning values               |
| `k8s/observability.yaml`     | `KSV-0023`  | Promtail needs read-only hostPath access for Kubernetes/container log collection  |
| `k8s/observability.yaml`     | `KSV-0125`  | Prometheus/Grafana/Loki/Promtail images are pinned to fixed upstream versions     |

### Semgrep warnings

Updated `semgrep.yml` excludes:

```yaml
**/src/**/*.spec.ts
**/src/**/__tests__/**
```

This replaces the stale patterns:

```yaml
src/**/*.spec.ts
src/**/__tests__/**
```

## Commands run

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

## Local scanner note

`npm run security:semgrep` could not be completed locally because the Windows Python/Semgrep executable did not become available to the active shell after installation. The CI workflow installs Semgrep immediately before running it, so the real Semgrep gate remains active in CI.

## Remaining risk

- npm audit currently reports 28 moderate vulnerabilities and 0 high/critical vulnerabilities. The configured gates fail on high/critical findings.
- Trivy Kubernetes medium findings are explicitly documented and narrowly validated by file, rule ID, and message content.
- No broad Trivy suppression was added.

## Final status

Phase 14 security CI fix is complete.
