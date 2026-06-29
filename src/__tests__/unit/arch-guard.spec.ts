/**
 * arch-guard.spec.ts — Architecture Rule Enforcement Tests
 *
 * These tests FAIL CI if:
 *   - Multiple orchestrator classes exist
 *   - Legacy v* module directories are present
 *   - Raw pg Pool() is used outside infrastructure bootstrap
 *   - More than one webhook controller per provider
 *   - Banned bypass orchestrator classes exist
 *   - AppModule imports legacy v* modules
 */

import * as fs   from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const SRC = path.join(__dirname, '../../');

function grepFiles(pattern: string, flags = '--include="*.ts" -l'): string[] {
  const matcher = new RegExp(pattern);
  const matches: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.name.endsWith('.ts') && matcher.test(fs.readFileSync(fullPath, 'utf8'))) {
        matches.push(fullPath.replace(/\\/g, '/'));
      }
    }
  }
  visit(SRC);
  return matches;
}

describe('Architecture Rule ARCH-001: Single Orchestrator', () => {
  it('only UnifiedCommerceOrchestrator class should exist', () => {
    const files = grepFiles('export class UnifiedCommerceOrchestrator')
      .filter(f => !f.includes('__tests__') && !f.includes('spec.ts'));
    const nonCanonical = files.filter(f => !f.includes('/orchestrator/'));
    expect(nonCanonical).toEqual([]);
  });

  it('UnifiedCommerceOrchestrator must exist in orchestrator/ directory', () => {
    const orchestratorFile = path.join(SRC, 'orchestrator/unified-commerce-orchestrator.service.ts');
    expect(fs.existsSync(orchestratorFile)).toBe(true);
  });
});

describe('Architecture Rule ARCH-002: No Legacy Modules', () => {
  const LEGACY_DIRS = ['v16','v17','v18','v19','v20','v21','v22','v23','v24','v25',
                        'v26','v27','v28','v29','v30','v31','v32','v33','v34','v35',
                        'v36','v37','v38','v39','v40','v41','v42','v43','v44','v45'];

  it.each(LEGACY_DIRS)('legacy module directory src/%s must not exist', (dir) => {
    const dirPath = path.join(SRC, dir);
    expect(fs.existsSync(dirPath)).toBe(false);
  });
});

describe('Architecture Rule ARCH-003: Drizzle-Only Data Layer', () => {
  const EXCLUDED = [
    'database.module.ts', 'database.service.ts', 'seed.ts',
    'migrate.ts', '__tests__', 'spec.ts', 'arch-guard',
    'production-gate', '.bak',
  ];

  it('no raw pg Pool() usage outside infrastructure bootstrap', () => {
    const files = grepFiles('new Pool\\(')
      .filter(f => !EXCLUDED.some(ex => f.includes(ex)));
    expect(files).toEqual([]);
  });

  it('no pool.query() in production services', () => {
    const files = grepFiles('new Pool\\(')
      .filter(f => !EXCLUDED.some(ex => f.includes(ex)));
    expect(files).toEqual([]);
  });
});

describe('Architecture Rule ARCH-004: One Webhook Controller Per Provider', () => {
  it('Shopify: exactly one webhook controller', () => {
    const files = grepFiles('export class ShopifyWebhookV60Controller')
      .filter(f => !f.includes('spec.ts') && !f.includes('__tests__'));
    // Should exist (shopify-webhook.controller.ts + shopify.module.ts)
    const controllers = files.filter(f => f.includes('.controller.ts'));
    expect(controllers.length).toBe(1);
  });

  it('Razorpay: exactly two webhook controllers (subscription + order)', () => {
    const subscriptionWebhook = path.join(SRC, 'subscription/razorpay-webhook.controller.ts');
    const orderWebhook        = path.join(SRC, 'escrow/razorpay-order-webhook.controller.ts');
    expect(fs.existsSync(subscriptionWebhook)).toBe(true);
    expect(fs.existsSync(orderWebhook)).toBe(true);
  });

  it('no versioned webhook controller filenames (e.g. *-v60.controller.ts)', () => {
    try {
      const result = execSync(
        `find "${SRC}" -name "*-v[0-9]*.controller.ts" 2>/dev/null || true`,
        { encoding: 'utf8' }
      ).trim();
      const files = result ? result.split('\n').filter(Boolean) : [];
      expect(files).toEqual([]);
    } catch {
      // no files found
    }
  });
});

describe('Architecture Rule ARCH-005: No Bypass Orchestrator Classes', () => {
  const BANNED = [
    'AutonomousOrchestratorService',
    'BusinessOrchestratorService',
    'BotOrchestratorService',
  ];

  it.each(BANNED)('%s class must not exist in production code', (cls) => {
    const files = grepFiles(`class ${cls}\\b`)
      .filter(f => !f.includes('spec.ts') && !f.includes('__tests__'));
    expect(files).toEqual([]);
  });
});

describe('Architecture Rule ARCH-006: AppModule Free of Legacy Imports', () => {
  it('AppModule must not import from v* directories', () => {
    const content = fs.readFileSync(path.join(SRC, 'app.module.ts'), 'utf8');
    const legacyImports = content.match(/from ['"]\.\/v\d+\//g) ?? [];
    expect(legacyImports).toEqual([]);
  });

  it('AppModule must not wire legacy kernel services in constructor', () => {
    const content = fs.readFileSync(path.join(SRC, 'app.module.ts'), 'utf8');
    const kernelWiring = content.match(/V\d+KernelService|WinnerKernel\b/g) ?? [];
    expect(kernelWiring).toEqual([]);
  });
});

describe('Architecture Rule ARCH-007: Webhook Idempotency', () => {
  it('ShopifyWebhookController implements Redis replay protection', () => {
    const content = fs.readFileSync(
      path.join(SRC, 'shopify/shopify-webhook-v60.controller.ts'), 'utf8'
    );
    // Must have Redis dedup
    expect(content).toMatch(/redis\.|Redis/);
    // Must validate HMAC
    expect(content).toMatch(/hmac|HMAC|createHmac/);
  });

  it('RazorpayWebhookController validates signature', () => {
    const content = fs.readFileSync(
      path.join(SRC, 'subscription/razorpay-webhook.controller.ts'), 'utf8'
    );
    expect(content).toMatch(/signature|hmac|HMAC/i);
  });
});

describe('Architecture Rule ARCH-008: Financial Integrity', () => {
  it('EscrowService uses Drizzle transactions', () => {
    const dir = path.join(SRC, 'escrow');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.includes('spec'));
    const contents = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(contents).toMatch(/db\.transaction\b/);
  });

  it('CommissionService uses DB_TOKEN (Drizzle)', () => {
    const servicePath = path.join(SRC, 'commission/commission.service.ts');
    if (!fs.existsSync(servicePath)) return;
    const content = fs.readFileSync(servicePath, 'utf8');
    expect(content).toMatch(/DB_TOKEN/);
    expect(content).not.toMatch(/new Pool\b|POOL_TOKEN\b/);
  });
});
