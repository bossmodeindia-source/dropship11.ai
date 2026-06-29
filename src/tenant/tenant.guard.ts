/**
 * TenantGuard — V63 Row-Level Tenant Isolation Enforcer (FIXED)
 *
 * Applied as a global guard (order 1 of 3: Tenant → JWT → Roles).
 *
 * FIX: Now also skips routes decorated with @Public() so unauthenticated
 * routes (register, login, telegram callback, health) work without a
 * tenant context in the request.
 *
 * Skip options:
 *   @Public()          — skips all three guards (JWT, Roles, Tenant)
 *   @SkipTenantGuard() — skips only this guard (useful for internal routes)
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';

export const SKIP_TENANT_GUARD = 'skipTenantGuard';
/** Mark a route as not requiring tenant isolation (public/system routes). */
export const SkipTenantGuard = () => SetMetadata(SKIP_TENANT_GUARD, true);

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip if route is @Public() (no auth required at all)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Skip if route is @SkipTenantGuard()
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_GUARD, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<Request & { tenantId?: string }>();
    if (!req.tenantId) {
      throw new UnauthorizedException('Request has no tenant context');
    }

    return true;
  }
}

/** Extract tenantId from the request (set by TenantMiddleware). */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request & { tenantId?: string }>();
    return req.tenantId ?? '';
  },
);

/** Extract userId from the JWT payload on the request. */
export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: { sub?: string; id?: string } }>();
    return req.user?.sub ?? req.user?.id ?? '';
  },
);
