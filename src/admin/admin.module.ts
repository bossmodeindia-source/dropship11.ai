/**
 * admin.module.ts — V65 PATCH
 *
 * SECURITY + CORRECTNESS FIX: Removed admin-v59.controller.ts and
 * admin-v60.controller.ts from the registered controller list.
 *
 * ── Problem (V64) ─────────────────────────────────────────────────────────────
 *
 * Three controllers were registered with overlapping routes:
 *   AdminController         — V64 unified (all routes, class-level guards)
 *   AdminV59Controller      — V59 legacy (subset of routes, method-level guards)
 *   AdminV60Controller      — V60 financial (subset of routes, class-level guards)
 *
 * NestJS registers routes in module order. When a route exists in multiple
 * controllers (e.g., POST /admin/mode), the LAST registered controller wins.
 * This is NON-DETERMINISTIC across deployments (depends on module load order).
 *
 * Security consequence: AdminV59Controller has some routes WITHOUT proper
 * method-level guards — e.g., GET /admin/status had no @UseGuards decorator.
 * Any authenticated user (not just admin) could access it.
 *
 * ── Fix (V65) ─────────────────────────────────────────────────────────────────
 *
 * Only AdminController (admin.controller.ts) is registered.
 * It is the unified, complete implementation with:
 *   - @UseGuards(JwtAuthGuard, RolesGuard) at CLASS level (no bypass possible)
 *   - @SkipTenantGuard() at class level (admin is cross-tenant by design)
 *   - @AuditLog() on every write operation
 *   - Full role matrix: admin vs superadmin enforced per endpoint
 *
 * The legacy files (admin-v59.controller.ts, admin-v60.controller.ts) are
 * kept on disk for reference but must never be re-added to this module.
 *
 * ── Verification ──────────────────────────────────────────────────────────────
 * After deploying, verify only one handler per route in logs:
 *   grep "RouterExplorer" logs | grep "admin" | sort | uniq -d
 * Expected: no duplicate routes.
 */

import { Module } from '@nestjs/common';
import { AdminController }       from './admin.controller';       // ✅ CANONICAL — unified
import { AdminUsersController }  from './admin-users.controller'; // ✅ /admin/users routes
import { AdminKeysController }   from './admin-keys.controller';  // ✅ runtime key management
// ❌ REMOVED: AdminV59Controller — legacy, overlapping routes, inconsistent guards
// import { AdminV59Controller } from './admin-v59.controller';
// ❌ REMOVED: AdminV60Controller — merged into AdminController
// import { AdminV60Controller } from './admin-v60.controller';
import { AdminUsersService }      from './admin-users.service';
import { ConfigVaultModule }      from '../config-vault/config-vault.module';
import { AiOrchestratorModule }   from '../ai-orchestrator/ai-orchestrator.module';
import { DatabaseModule }         from '../common/database/database.module';
import { SystemModeModule }       from '../system-mode/system-mode.module';
import { FailSafeModule }         from '../failsafe/failsafe.module';
import { QueueModule }            from '../queue/queue.module';
import { RecoveryModule }         from '../recovery/recovery.module';
import { CostProtectionModule }   from '../cost-protection/cost-protection.module';
import { AuditModule }            from '../audit/audit.module';
import { RealtimeModule }         from '../realtime/realtime.module';
import { ObservabilityModule }    from '../observability/observability.module';
import { WithdrawalModule }       from '../withdrawal/withdrawal.module';

@Module({
  imports: [
    DatabaseModule,
    ConfigVaultModule,
    AiOrchestratorModule,
    SystemModeModule,
    FailSafeModule,
    QueueModule,
    RecoveryModule,
    CostProtectionModule,
    AuditModule,
    RealtimeModule,
    ObservabilityModule,
    WithdrawalModule,
  ],
  controllers: [
    AdminController,       // ✅ unified: system + finance + withdrawals + user ops
    AdminUsersController,  // ✅ legacy /admin/users routes (dashboard compat)
    AdminKeysController,   // ✅ runtime key management
    // AdminV59Controller  // ❌ NEVER RE-ADD
    // AdminV60Controller  // ❌ NEVER RE-ADD
  ],
  providers: [AdminUsersService],
})
export class AdminModule {}
