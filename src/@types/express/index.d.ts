/**
 * Express Request augmentation — extends the base Request type with
 * fields added by NestJS middleware (tenant, auth, raw body).
 *
 * This eliminates all `(req as any).tenantId` style casts.
 */
declare namespace Express {
  interface Request {
    /** Injected by TenantMiddleware */
    tenantId?: string;
    /** Injected by TenantMiddleware / JwtAuthGuard */
    userId?: string;
    /** Injected by TenantMiddleware — the user's subscription plan */
    userPlan?: string;
    /** Captured by rawBodyMiddleware in main.ts before JSON parsing */
    rawBody?: Buffer;
    /** Internal body-parser reset flag */
    _body?: boolean;
  }
}
