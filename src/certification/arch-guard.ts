/**
 * arch-guard.ts — Architecture Guardrails
 *
 * Runs at build-time (prebuild) and in CI.
 * FAILS BUILD if any of these conditions are detected:
 *
 *   1. Multiple orchestrator classes
 *   2. Legacy v* module directories present
 *   3. Raw pg Pool() usage in production services
 *   4. Duplicate webhook controllers per provider
 *   5. Direct workflow execution (bypasses master orchestrator)
 *
 * Called via: ts-node src/certification/arch-guard.ts
 */

import { execSync } from 'child_process';
import * as fs      from 'fs';
import * as path    from 'path';

const SRC = path.join(__dirname, '..'); // src/
const RED  = '\x1b[31m';
const GRN  = '\x1b[32m';
const YLW  = '\x1b[33m';
const RST  = '\x1b[0m';

interface Violation {
  rule:    string;
  files:   string[];
  message: string;
}

const violations: Violation[] = [];

function fail(rule: string, message: string, files: string[]): void {
  violations.push({ rule, message, files });
}

function pass(rule: string): void {
  console.log(`${GRN}  ✓${RST} ${rule}`);
}

function listTypescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }
      files.push(...listTypescriptFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/');
}

// ─── Rule 1: Single orchestrator class ──────────────────────────────────────
function checkSingleOrchestrator(): void {
  const ORCHESTRATOR_CLASS_RE =
    /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]*Orchestrator[A-Za-z0-9_]*)\b/g;

  const orchestratorClasses: string[] = [];

  for (const file of listTypescriptFiles(SRC)) {
    const normalized = normalizeFile(file);
    const baseName = path.basename(file);

    if (
      normalized.includes('/__tests__/') ||
      normalized.endsWith('.spec.ts') ||
      normalized.endsWith('.e2e-spec.ts') ||
      normalized.endsWith('.module.ts')
    ) {
      continue;
    }

    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(ORCHESTRATOR_CLASS_RE)) {
      const className = match[1];
      if (className.endsWith('Module')) {
        continue;
      }
      orchestratorClasses.push(`${className} in ${normalized}`);
    }
  }

  const canonical = orchestratorClasses.filter((entry) =>
    entry.includes('/orchestrator/unified-commerce-orchestrator.service.ts'),
  );
  const nonCanonical = orchestratorClasses.filter(
    (entry) => !entry.includes('/orchestrator/unified-commerce-orchestrator.service.ts'),
  );

  if (canonical.length === 1 && nonCanonical.length === 0 && orchestratorClasses.length === 1) {
    pass('ARCH-001: Single orchestrator (UnifiedCommerceOrchestrator)');
    return;
  }

  const files = orchestratorClasses.length > 0 ? orchestratorClasses : [SRC];
  fail(
    'ARCH-001',
    'Exactly one real orchestrator class is allowed: UnifiedCommerceOrchestrator in src/orchestrator/. NestJS module files are ignored.',
    files,
  );
}

// ─── Rule 2: No legacy v* module directories ────────────────────────────────
function checkNoLegacyModules(): void {
  const legacyDirs = ['v16','v17','v18','v19','v20','v21','v22','v23','v24','v25',
                       'v26','v27','v28','v29','v30','v31','v32','v33','v34','v35',
                       'v36','v37','v38','v39','v40','v41','v42','v43','v44','v45'];
  const found: string[] = [];
  for (const dir of legacyDirs) {
    const p = path.join(SRC, dir);
    if (fs.existsSync(p)) found.push(p);
  }
  if (found.length > 0) {
    fail('ARCH-002', 'Legacy version module directories present — must be deleted', found);
  } else {
    pass('ARCH-002: No legacy v* modules present');
  }
}

// ─── Rule 3: No raw pg Pool in production services ──────────────────────────
function checkNoPgPool(): void {
  const EXCLUDED_PATTERNS = [
    'database.module.ts',    // bootstrap only
    'database.service.ts',   // migration compat wrapper
    'seed.ts',               // seed script
    'migrate.ts',            // migration script
    '__tests__',             // test files
    'spec.ts',               // test files
    'arch-guard.ts',         // this file
    'production-gate',       // gate script
    '.bak',                  // backups
  ];

  try {
    const result = execSync(
      `grep -r "new Pool(" "${SRC}" --include="*.ts" -l`,
      { encoding: 'utf8' }
    ).trim();
    const files = result ? result.split('\n').filter(Boolean) : [];
    const violations = files.filter(f =>
      !EXCLUDED_PATTERNS.some(pat => f.includes(pat))
    );
    if (violations.length > 0) {
      fail('ARCH-003', 'Raw pg Pool() usage in production services — use Drizzle ORM', violations);
    } else {
      pass('ARCH-003: Drizzle-only data layer (no raw pg Pool in production)');
    }
  } catch {
    pass('ARCH-003: Drizzle-only data layer');
  }
}

// ─── Rule 4: No duplicate webhook controllers per provider ──────────────────
function checkWebhookUniqueness(): void {
  const providers = ['shopify', 'razorpay', 'meta', 'telegram', 'supplier', 'tracking'];
  const byProviderDomain = new Map<string, string[]>();
  const providerDomains = new Map<string, Set<string>>();

  const getControllerRoutes = (content: string): string[] => {
    const routes: string[] = [];
    const controllerRouteRe = /@Controller\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    for (const match of content.matchAll(controllerRouteRe)) {
      routes.push(match[1].replace(/^\/+|\/+$/g, '').toLowerCase());
    }
    return routes;
  };

  const getClassNames = (content: string): string[] => {
    const classNames: string[] = [];
    const classNameRe = /\bclass\s+([A-Za-z0-9_]+)/g;
    for (const match of content.matchAll(classNameRe)) {
      classNames.push(match[1].toLowerCase());
    }
    return classNames;
  };

  const getWebhookDomain = (
    provider: string,
    route: string,
    base: string,
    classNames: string[],
  ): string => {
    const haystack = `${route} ${base} ${classNames.join(' ')}`.toLowerCase();
    if (provider === 'razorpay') {
      if (haystack.includes('subscription') || route.includes('billing/webhook')) return 'subscriptions';
      if (haystack.includes('order') || haystack.includes('escrow')) return 'orders';
      return 'default';
    }
    if (provider === 'shopify' && haystack.includes('return-shield')) {
      return 'return-shield';
    }
    return 'default';
  };

  const isSafeRouteDomain = (provider: string, domain: string, route: string): boolean => {
    if (provider === 'razorpay') {
      if (domain === 'orders') return route === 'webhooks/razorpay/orders';
      if (domain === 'subscriptions') {
        return route === 'webhooks/razorpay/subscriptions' || route === 'billing/webhook';
      }
      return false;
    }
    if (provider === 'shopify' && domain === 'return-shield') {
      return route === 'webhooks/shopify/return-shield';
    }
    return true;
  };

  for (const file of listTypescriptFiles(SRC)) {
    const normalized = normalizeFile(file);
    const base = path.basename(file).toLowerCase();
    if (
      normalized.includes('/__tests__/') ||
      normalized.endsWith('.spec.ts') ||
      normalized.endsWith('.e2e-spec.ts') ||
      !base.endsWith('.controller.ts')
    ) {
      continue;
    }

    const content = fs.readFileSync(file, 'utf8');
    const routes = getControllerRoutes(content);
    const classNames = getClassNames(content);
    const isWebhookController = base.includes('webhook') || routes.some((route) => route.includes('webhook'));
    if (!isWebhookController) continue;

    for (const route of routes.length ? routes : ['']) {
      for (const provider of providers) {
        const providerMentioned =
          base.includes(provider) ||
          route.includes(provider) ||
          classNames.some((className) => className.includes(provider));
        if (!providerMentioned) continue;

        const domain = getWebhookDomain(provider, route, base, classNames);
        const safe = isSafeRouteDomain(provider, domain, route);
        const key = `${provider}:${domain}`;
        const entry = `[${provider}/${domain}] ${normalized} @Controller('${route}')`;

        if (!safe) {
          fail(
            'ARCH-004',
            'Unsafe or ambiguous webhook controller route domain',
            [entry],
          );
          continue;
        }

        if (!byProviderDomain.has(key)) byProviderDomain.set(key, []);
        byProviderDomain.get(key)!.push(entry);

        if (!providerDomains.has(provider)) providerDomains.set(provider, new Set());
        providerDomains.get(provider)!.add(domain);
      }
    }
  }

  const duplicateDomains = [...byProviderDomain.entries()].filter(([, files]) => files.length > 1);
  if (duplicateDomains.length > 0) {
    const dupFiles = duplicateDomains.flatMap(([, files]) => files);
    fail('ARCH-004', 'Multiple webhook controllers for the same provider/domain', dupFiles);
    return;
  }

  pass('ARCH-004: One webhook controller per provider/domain');
}

// ─── Rule 5: No AutonomousOrchestratorService (bypass path) ─────────────────
function checkNoBypassOrchestrators(): void {
  const BANNED_CLASSES = [
    'AutonomousOrchestratorService',
    'BusinessOrchestratorService',
    'AiOrchestratorService',
    'BotOrchestratorService',
  ];

  const found: string[] = [];
  for (const cls of BANNED_CLASSES) {
    try {
      const result = execSync(
        `grep -r "class ${cls}\\b" "${SRC}" --include="*.ts" -l | grep -v "__tests__" | grep -v "spec.ts"`,
        { encoding: 'utf8' }
      ).trim();
      if (result) found.push(...result.split('\n').map(f => `${cls} in ${f}`));
    } catch { /* not found — good */ }
  }

  if (found.length > 0) {
    fail('ARCH-005', 'Banned orchestrator bypass classes detected', found);
  } else {
    pass('ARCH-005: No orchestrator bypass classes');
  }
}

// ─── Rule 6: AppModule must not import v* modules ───────────────────────────
function checkAppModuleClean(): void {
  const appModule = path.join(SRC, 'app.module.ts');
  const content   = fs.readFileSync(appModule, 'utf8');
  const legacyRe  = /from ['"]\.\/v\d+\//g;
  const matches   = content.match(legacyRe) ?? [];
  if (matches.length > 0) {
    fail('ARCH-006', 'AppModule imports legacy v* modules', matches);
  } else {
    pass('ARCH-006: AppModule free of legacy v* imports');
  }
}

// ─── Run all rules ───────────────────────────────────────────────────────────
console.log('\n🔍 Architecture Guardrails — AI Empire Enterprise\n');
checkSingleOrchestrator();
checkNoLegacyModules();
checkNoPgPool();
checkWebhookUniqueness();
checkNoBypassOrchestrators();
checkAppModuleClean();

// ─── Result ──────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.log(`\n${RED}╔══════════════════════════════════════════════════════════╗${RST}`);
  console.log(`${RED}║  ARCHITECTURE VIOLATIONS DETECTED — BUILD BLOCKED         ║${RST}`);
  console.log(`${RED}╚══════════════════════════════════════════════════════════╝${RST}\n`);
  for (const v of violations) {
    console.error(`${RED}✗ ${v.rule}: ${v.message}${RST}`);
    for (const f of v.files) console.error(`    ${YLW}→ ${f}${RST}`);
  }
  console.error(`\n${violations.length} rule(s) violated. Fix before build.\n`);
  process.exit(1);
} else {
  console.log(`\n${GRN}╔══════════════════════════════════════════════════════════╗${RST}`);
  console.log(`${GRN}║  ALL ARCHITECTURE RULES PASS — BUILD PROCEEDS             ║${RST}`);
  console.log(`${GRN}╚══════════════════════════════════════════════════════════╝${RST}\n`);
}
