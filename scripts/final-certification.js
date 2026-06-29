const fs = require('fs');
const path = require('path');

const root = process.cwd();

const requiredFiles = [
  '.github/workflows/certification.yml',
  'Dockerfile',
  'eslint.config.mjs',
  '.prettierrc.json',
  'semgrep.yml',
  'trivy.yaml',
  'openapi/openapi.json',
  'playwright.config.ts',
  'SECURITY_CI_CERTIFICATION_REPORT.md',
];

const requiredScripts = [
  'build',
  'certify',
  'certify:strict',
  'test',
  'test:contract',
  'test:playwright',
  'lint:check',
  'format:check',
  'security:audit-npm',
  'security:audit-ci',
  'security:semgrep',
  'security:osv',
  'security:trivy:fs',
  'security:trivy:docker',
  'docker:build',
  'certification:final',
];

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts ?? {};

const missingFiles = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
const missingScripts = requiredScripts.filter((script) => !scripts[script]);

const forbiddenPatterns = [
  { script: 'test', pattern: /--forceExit/, reason: 'Jest forceExit is not allowed' },
  { script: 'test', pattern: /--passWithNoTests/, reason: 'Skipping empty test runs is not allowed' },
  { script: 'test:coverage:final', pattern: /--coverage=false/, reason: 'Coverage cannot be disabled' },
];

const forbiddenFindings = forbiddenPatterns.filter(({ script, pattern }) =>
  pattern.test(String(scripts[script] ?? '')),
);

if (missingFiles.length || missingScripts.length || forbiddenFindings.length) {
  console.error('Final certification wiring failed.');
  if (missingFiles.length) console.error(`Missing files: ${missingFiles.join(', ')}`);
  if (missingScripts.length) console.error(`Missing scripts: ${missingScripts.join(', ')}`);
  for (const finding of forbiddenFindings) {
    console.error(`${finding.script}: ${finding.reason}`);
  }
  process.exit(1);
}

console.log('Final certification wiring passed.');
console.log(`Verified files: ${requiredFiles.length}`);
console.log(`Verified scripts: ${requiredScripts.length}`);
