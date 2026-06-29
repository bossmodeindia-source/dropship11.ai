const fs = require('fs');

const reportPath = process.argv[2] || 'trivy-misconfig.json';
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const allowedMediumMisconfigs = [
  {
    target: 'api-deployment.yaml',
    id: 'KSV-0125',
    messageIncludes: ['Container api', 'aiempire-api', 'untrusted registry'],
    reason: 'Pinned private GHCR org image ghcr.io/bossmodeindia-source/aiempire-nestjs:v69.',
  },
  {
    target: 'worker-deployment.yaml',
    id: 'KSV-0125',
    messageIncludes: ['Container worker', 'aiempire-worker', 'untrusted registry'],
    reason: 'Pinned private GHCR org image ghcr.io/bossmodeindia-source/aiempire-nestjs:v69.',
  },
  {
    target: 'configmap.yaml',
    id: 'KSV-01010',
    messageIncludes: ['aiempire-config', 'PORT', 'THROTTLE_LIMIT'],
    reason: 'PORT and THROTTLE_LIMIT are non-sensitive runtime tuning values.',
  },
  {
    target: 'observability.yaml',
    id: 'KSV-0023',
    messageIncludes: ['promtail', 'hostPath'],
    reason: 'Promtail requires read-only hostPath log access for Kubernetes log collection.',
  },
  {
    target: 'observability.yaml',
    id: 'KSV-0125',
    messageIncludes: ['Container prometheus', 'untrusted registry'],
    reason: 'Official Prometheus image is pinned to a fixed upstream version.',
  },
  {
    target: 'observability.yaml',
    id: 'KSV-0125',
    messageIncludes: ['Container grafana', 'untrusted registry'],
    reason: 'Official Grafana image is pinned to a fixed upstream version.',
  },
  {
    target: 'observability.yaml',
    id: 'KSV-0125',
    messageIncludes: ['Container loki', 'untrusted registry'],
    reason: 'Official Loki image is pinned to a fixed upstream version.',
  },
  {
    target: 'observability.yaml',
    id: 'KSV-0125',
    messageIncludes: ['Container promtail', 'untrusted registry'],
    reason: 'Official Promtail image is pinned to a fixed upstream version.',
  },
];

function targetName(target) {
  return String(target || '').replace(/\\/g, '/').split('/').pop();
}

function isAllowed(misconfig, target) {
  if (misconfig.Severity !== 'MEDIUM') return false;
  const message = misconfig.Message || '';
  const normalizedTarget = targetName(target);

  return allowedMediumMisconfigs.some((allowed) =>
    allowed.target === normalizedTarget &&
    allowed.id === misconfig.ID &&
    allowed.messageIncludes.every((part) => message.includes(part)),
  );
}

const violations = [];
const allowed = [];

for (const result of report.Results || []) {
  for (const misconfig of result.Misconfigurations || []) {
    if (misconfig.Status !== 'FAIL') continue;

    if (isAllowed(misconfig, result.Target)) {
      allowed.push({
        target: targetName(result.Target),
        id: misconfig.ID,
        severity: misconfig.Severity,
        message: misconfig.Message,
      });
      continue;
    }

    violations.push({
      target: targetName(result.Target),
      id: misconfig.ID,
      severity: misconfig.Severity,
      title: misconfig.Title,
      message: misconfig.Message,
    });
  }
}

if (violations.length > 0) {
  console.error('Unexpected Trivy misconfiguration findings:');
  for (const violation of violations) {
    console.error(`- ${violation.severity} ${violation.id} ${violation.target}: ${violation.message}`);
  }
  process.exit(1);
}

console.log(`Trivy misconfiguration validation passed. Accepted documented medium findings: ${allowed.length}.`);
