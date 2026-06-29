/**
 * src/common/guards/index.ts — V60 CANONICAL GUARD BARREL
 *
 * SINGLE canonical export point for ALL guards.
 *
 * P0-1 Fix: All imports must come from HERE, never from:
 *   - src/auth/guards/   ← DELETED
 *   - any legacy v-module guards
 *
 * Usage:
 *   import { JwtAuthGuard, RolesGuard, TenantGuard } from '../common/guards';
 *
 * Guard execution order (registered in AppModule via APP_GUARD):
 *   1. TenantGuard   — resolves + binds tenant context
 *   2. JwtAuthGuard  — validates JWT access token
 *   3. RolesGuard    — RBAC enforcement
 *   4. SubscriptionGuard — plan/quota enforcement (route-level)
 */

export { JwtAuthGuard }       from './jwt-auth.guard';
export { RolesGuard }         from './roles.guard';
export { TenantGuard }        from '../../tenant/tenant.guard';
export { SubscriptionGuard }  from './subscription.guard';
export { WebhookHmacGuard }   from './webhook-hmac.guard';
export { InputValidationGuard } from './input-validation.guard';
