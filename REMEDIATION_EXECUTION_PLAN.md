# AI Empire V68 — Enterprise Remediation Execution Plan
**Target: 10/10 Enterprise Certification**  
**Estimated engineering effort: 3–4 sprints**

---

## STOP: Read Before Starting

Apply fixes in strict order. Each phase depends on the previous.  
Do NOT skip Phase 1 — the app cannot start in production until BUG-001 is fixed.

---

## Phase 1 — Immediate: Stop the Boot Crash (Hour 1)

```bash
# Step 1: Remove V45Module import from AppModule
# Edit src/app.module.ts manually:
#   - Delete line: import { V45Module } from './v45/v45.module';
#   - Delete line: V45Module,   (from the @Module imports array)

# Step 2: Delete V45 directory
rm -rf src/v45/

# Step 3: Verify app starts
npm run build
npm run start:dev
# Must reach: "Application is running on port 3000"
```

**Files modified:** `src/app.module.ts`  
**Files deleted:** `src/v45/` (entire directory, 12 files)  
**Risk:** None — V45 is entirely superseded

---

## Phase 2 — This Sprint: Architecture Violation Remediation (Days 1–5)

### 2A: Remove all legacy v* modules from AppModule

```bash
# Apply FIX-002-app-module-cleanup.ts guidance to src/app.module.ts
# Remove 19 module imports + constructor injections (see fix file for exact lines)

# Then run the purge script:
chmod +x FIX-002-legacy-purge.sh
./FIX-002-legacy-purge.sh

# Verify build
npm run build
```

**Impact:** 240 TypeScript files removed, 196 raw pg.Pool violations eliminated  
**Risk:** Medium — any feature that was only implemented in a v* module is lost.  
**Mitigation:** All features in v16–v45 are superseded by production modules (see AV-003 in audit report)

### 2B: Rename versioned webhook controllers

```bash
chmod +x FIX-003-rename-webhooks.sh
./FIX-003-rename-webhooks.sh
npm run build
```

**Files renamed:** 3 webhook controllers (see FIX-003 for details)  
**Risk:** Low — only filename and class name changes; behavior unchanged

### 2C: Delete dead admin controller files

```bash
rm src/admin/admin-v59.controller.ts
rm src/admin/admin-v60.controller.ts
# Verify they're not referenced anywhere:
grep -r "admin-v59\|admin-v60\|AdminV59\|AdminV60" src/ --include="*.ts"
# Expected: zero results (admin.module.ts already has them commented out)
```

**Risk:** None — files already deregistered from the module

### 2D: Merge outbox implementations

```bash
# Apply FIX-005-outbox-deduplication.ts guidance
# 1. Append DLQ methods to src/common/outbox/outbox.service.ts
# 2. Add migration for DLQ status constraint
# 3. rm -rf src/outbox/
npm run build
```

---

## Phase 3 — Next Sprint: Financial Integrity Hardening (Days 6–10)

### 3A: Add CommissionFailureGuard

```bash
# Copy FIX-007-commission-failure-guard.ts to:
cp FIX-007-commission-failure-guard.ts src/commission/commission-failure.guard.ts

# Follow FIX-007b-commission-pipeline-integration.ts guidance to update:
#   src/commerce/commerce-pipeline.service.ts
#   src/commission/commission.module.ts

npm run build
npm run test
```

### 3B: Migrate return-shield to Drizzle

```bash
# Files to migrate from raw pg.Pool to @Inject(DB_TOKEN) + Drizzle:
#   src/return-shield/services/return-request.service.ts
#   src/return-shield/services/return-audit.service.ts
#   src/return-shield/services/return-fraud-detection.service.ts
#   src/return-shield/controllers/shopify-return-intercept.controller.ts

# Pattern: replace @Inject('PG_POOL') private readonly pool: Pool
# with:    @Inject(DB_TOKEN) private readonly db: DrizzleDB
# Replace: await pool.query('SELECT ...', [...])
# with:    await db.select().from(table).where(...)
```

---

## Phase 4 — Coverage Enforcement (Days 11–14)

### 4A: Add coverage threshold to package.json

```bash
# Apply FIX-009-coverage-threshold.ts guidance
# Add coverageThreshold to package.json jest config
# Start at 40% global to document baseline, raise each sprint

npm run test:cov
# Review output — identify modules with <40% coverage
```

### 4B: Write missing tests for financial paths

Priority order (highest risk first):
1. `src/commission/` — CommissionService + CommissionFailureGuard
2. `src/escrow/` — EscrowTransactionService (already has spec, increase coverage)
3. `src/orders/` — OrdersService + IdempotencyService
4. `src/supplier-payment/` — SupplierPaymentService
5. `src/common/outbox/` — OutboxService flush + DLQ sweep

---

## Phase 5 — Remaining Raw pg.Pool Migration (Sprint 3)

After Phase 2 removes the v* modules, ~40 production service files will still
use raw pg.Pool. Migrate these in priority order:

```
HIGH PRIORITY (financial/critical path):
  src/audit/audit.service.ts
  src/finance-tracking/finance-tracking.service.ts
  src/financial-failsafe/financial-failsafe.service.ts
  src/plan-limits/plan-limits.service.ts

MEDIUM PRIORITY (webhook handlers):
  src/return-shield/services/*.ts (covered in Phase 3B)
  src/telegram-storage/telegram-asset.repository.ts

LOWER PRIORITY (analytics/reporting — no financial risk):
  src/ai-provider-registry/ai-provider-registry.service.ts
  src/ai-usage-analytics/ai-usage-analytics.service.ts
  src/shopify/shopify-revenue.service.ts
```

**Migration pattern for all files:**

```typescript
// BEFORE:
import { Pool } from 'pg';
// ...
constructor(@Inject('PG_POOL') private readonly pool: Pool) {}
// ...
const { rows } = await this.pool.query('SELECT * FROM table WHERE id = $1', [id]);

// AFTER:
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import { eq } from 'drizzle-orm';
import * as schema from '../common/database/schema';
// ...
constructor(@Inject(DB_TOKEN) private readonly db: DrizzleDB) {}
// ...
const rows = await this.db.select().from(schema.table).where(eq(schema.table.id, id));
```

---

## Certification Gate Verification Commands

Run these after each phase to verify certification progress:

```bash
# Architecture
grep -r "V44Module\|V45Module\|V43Module" src/ --include="*.ts"  # Must be empty
grep -r "from 'pg'" src/ --include="*.ts" | grep -v "spec\|test\|database.module\|migrate"  # Should shrink to ~5 after all phases

# No duplicate controllers
ls src/admin/*v59* src/admin/*v60* 2>/dev/null  # Must be empty
ls src/shopify/*v60* 2>/dev/null  # Must be empty after FIX-003

# Single outbox
ls src/outbox/ 2>/dev/null  # Must not exist

# Coverage
npm run test:cov | grep -E "All files|Branches|Functions|Lines"

# Build passes
npm run build

# Boot
npm run start:dev &
sleep 10
curl http://localhost:3000/health | python3 -m json.tool
kill %1
```

---

## Final Scorecard (Expected Post-Fix)

| Category | Current | Target | Post-Fix |
|---|---|---|---|
| Architecture | 4/10 | 10/10 | ✅ 10/10 |
| Security | 8/10 | 10/10 | ✅ 10/10 |
| Scalability | 7/10 | 10/10 | ✅ 9/10* |
| Commerce Reliability | 9/10 | 10/10 | ✅ 10/10 |
| Financial Integrity | 8/10 | 10/10 | ✅ 10/10 |
| Observability | 8/10 | 10/10 | ✅ 9/10* |
| Disaster Recovery | 9/10 | 10/10 | ✅ 10/10 |
| Maintainability | 3/10 | 10/10 | ✅ 10/10 |

*Scalability and Observability reach 9/10 after these fixes. Full 10/10 requires
load testing under simulated webhook storms and adding SLO-based Prometheus alerting
rules — a subsequent performance sprint.
