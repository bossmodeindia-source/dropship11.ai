/**
 * TenantMiddleware — V60 PATCHED
 *
 * Fix applied:
 *   [H5] Fail-closed on Redis/DB error.
 *
 *   BEFORE: catch block set isActive = true on any infrastructure error,
 *           allowing suspended tenants to bypass enforcement whenever Redis
 *           or the DB had a hiccup.
 *
 *   AFTER:  catch block throws ServiceUnavailableException (503).
 *           Requests fail visibly rather than silently granting access.
 *           The outer load balancer / client retries will recover once infra
 *           is healthy. A suspended tenant can never slip through.
 *
 *           503 is used (not 401) so callers can distinguish an auth failure
 *           from a temporary infra outage and retry with backoff.
 */

import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
  ServiceUnavailableException,
  Logger,
  Inject,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { TenantContext }        from './tenant.context';
import { REDIS_CLIENT }        from '../common/redis/redis.module';
import { DB_POOL }             from '../common/database/database.module';
import { addTenantToSpan }     from '../observability/tracing'; // V65: OTEL baggage

const PUBLIC_PATHS = new Set([
  '/health',
  '/metrics',
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/telegram',           // Telegram Login Widget (POST)
  '/api/v1/auth/telegram/callback',  // Telegram Login Widget redirect (GET)
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/docs',
]);

const WEBHOOK_PREFIXES = ['/api/v1/webhooks/', '/webhooks/'];

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);
  private readonly internalKey: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(DB_POOL) private readonly db: Pool,
  ) {
    this.internalKey = this.config.get<string>('INTERNAL_SERVICE_KEY', '');
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = req.path;

    // ── Skip public routes ─────────────────────────────────────────────────
    if (
      PUBLIC_PATHS.has(path) ||
      WEBHOOK_PREFIXES.some(prefix => path.startsWith(prefix)) ||
      path.startsWith('/api/docs')
    ) {
      return next();
    }

    // ── Internal service bypass ────────────────────────────────────────────
    const internalKey = req.headers['x-internal-service-key'] as string;
    if (internalKey && internalKey === this.internalKey && this.internalKey) {
      const tenantOverride = req.headers['x-tenant-id'] as string;
      if (!tenantOverride) {
        return TenantContext.runSystem(() => next());
      }
      return TenantContext.run(tenantOverride, () => next());
    }

    // ── Extract JWT ────────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing authorization token');
    }

    const token = authHeader.slice(7);
    let payload: { sub: string; tenant_id: string; email: string; plan: string };

    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { sub: userId, tenant_id: tenantId } = payload;
    if (!tenantId || !userId) {
      throw new UnauthorizedException('Token missing tenant context');
    }

    // ── Validate tenant is active (Redis cache → DB fallback) ──────────────
    const cacheKey = `tenant:active:${tenantId}`;
    let isActive: boolean;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        isActive = cached === '1';
      } else {
        const result = await this.db.query<{ active: boolean }>(
          'SELECT active FROM tenants WHERE id = $1 LIMIT 1',
          [tenantId],
        );
        isActive = result.rows[0]?.active === true;

        // Best-effort cache — if this write fails we re-query next request (acceptable)
        try {
          await this.redis.setex(cacheKey, 60, isActive ? '1' : '0');
        } catch (cacheWriteErr) {
          this.logger.warn(
            `Tenant cache write failed for ${tenantId}: ${(cacheWriteErr as Error).message}`,
          );
        }
      }
    } catch (err) {
      // [H5 FIX] FAIL CLOSED — do NOT grant access on infra errors.
      // Before: isActive = true (open) — suspended tenants bypassed enforcement.
      // After:  throw 503 — request fails visibly; client retries when infra recovers.
      this.logger.error(
        `[H5] Tenant validation infrastructure error for ${tenantId}: ${(err as Error).message}. ` +
        `Failing closed (503) to prevent suspended tenants from gaining access.`,
      );
      throw new ServiceUnavailableException(
        'Tenant validation temporarily unavailable. Please retry.',
      );
    }

    if (!isActive) {
      throw new UnauthorizedException('Tenant account is suspended');
    }

    // ── Attach to request object for downstream use ────────────────────────
    req.tenantId  = tenantId;
    req.userId    = userId;
    req.userPlan  = payload.plan;

    // V65: Propagate tenant ID into the active OTEL span as baggage
    // so every DB query, queue job, and downstream HTTP call carries it.
    addTenantToSpan(tenantId);

    TenantContext.run(tenantId, () => next());
  }
}
