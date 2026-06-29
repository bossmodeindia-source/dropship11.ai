/**
 * RateLimitMiddleware — V59 Multi-Layer Rate Limiting
 *
 * Three layers, applied in order:
 *
 *   Layer 1: Per-IP limits (anti-scraping / DDoS protection)
 *     - 200 req/min per IP (all routes)
 *     - 10 req/min per IP on auth routes (brute-force protection)
 *
 *   Layer 2: Per-user limits (prevent API abuse after auth)
 *     - free:  60  req/min
 *     - pro:   300 req/min
 *     - elite: 1000 req/min
 *
 *   Layer 3: Per-route rate limits (protect expensive endpoints)
 *     - /api/v1/creative/generate: 10 req/min (AI generation)
 *     - /api/v1/campaigns:         20 req/min (campaign launch)
 *     - /api/v1/products/discover: 5  req/min (trend scanning)
 *
 * Uses Redis sliding window (token bucket via INCR + EXPIRE).
 * Returns standard headers: X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After
 */

import {
  Injectable,
  NestMiddleware,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

type PlanTier = 'free' | 'pro' | 'elite';

// Per-plan user-level rate limits (requests per minute)
const PLAN_LIMITS: Record<PlanTier, number> = {
  free:  60,
  pro:   300,
  elite: 1_000,
};

// Per-route limits (requests per minute per user)
const ROUTE_LIMITS: Record<string, number> = {
  '/api/v1/creative/generate':  10,
  '/api/v1/campaigns':          20,
  '/api/v1/products/discover':   5,
  '/api/v1/organic/post':       10,
};

// Auth routes — strict IP limiting
const AUTH_ROUTES = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
]);

const IP_LIMIT_PER_MIN       = 200;
const IP_AUTH_LIMIT_PER_MIN  = 10;
const WINDOW_SECONDS         = 60;

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitMiddleware.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ip        = this.getIp(req);
    const userId    = req.userId;
    const userPlan  = (req.userPlan as PlanTier | undefined) ?? 'free';
    const path      = req.path;

    // ── Layer 1: IP rate limit ───────────────────────────────────────────────
    const ipLimit = AUTH_ROUTES.has(path) ? IP_AUTH_LIMIT_PER_MIN : IP_LIMIT_PER_MIN;
    const ipKey   = `rl:ip:${ip}:${Math.floor(Date.now() / (WINDOW_SECONDS * 1000))}`;
    const ipCount = await this.increment(ipKey, WINDOW_SECONDS);

    res.setHeader('X-RateLimit-IP-Limit',     String(ipLimit));
    res.setHeader('X-RateLimit-IP-Remaining', String(Math.max(0, ipLimit - ipCount)));

    if (ipCount > ipLimit) {
      this.logger.warn(`IP rate limit exceeded: ${ip} on ${path}`);
      return this.tooManyRequests(res, WINDOW_SECONDS);
    }

    // ── Layer 2: Per-user rate limit ─────────────────────────────────────────
    if (userId) {
      const userLimit = PLAN_LIMITS[userPlan];
      const userKey   = `rl:user:${userId}:${Math.floor(Date.now() / (WINDOW_SECONDS * 1000))}`;
      const userCount = await this.increment(userKey, WINDOW_SECONDS);

      res.setHeader('X-RateLimit-Limit',     String(userLimit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, userLimit - userCount)));

      if (userCount > userLimit) {
        this.logger.warn(`User rate limit exceeded: ${userId} (${userPlan}) on ${path}`);
        return this.tooManyRequests(res, WINDOW_SECONDS);
      }

      // ── Layer 3: Per-route rate limit ──────────────────────────────────────
      const normalizedPath = this.normalizePath(path);
      const routeLimit     = ROUTE_LIMITS[normalizedPath];
      if (routeLimit) {
        const routeKey   = `rl:route:${userId}:${normalizedPath}:${Math.floor(Date.now() / (WINDOW_SECONDS * 1000))}`;
        const routeCount = await this.increment(routeKey, WINDOW_SECONDS);

        res.setHeader('X-RateLimit-Route-Limit',     String(routeLimit));
        res.setHeader('X-RateLimit-Route-Remaining', String(Math.max(0, routeLimit - routeCount)));

        if (routeCount > routeLimit) {
          this.logger.warn(`Route rate limit exceeded: ${userId} on ${normalizedPath}`);
          return this.tooManyRequests(res, WINDOW_SECONDS);
        }
      }
    }

    next();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async increment(key: string, ttl: number): Promise<number> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, ttl);
    const results = await pipeline.exec();
    return (results?.[0]?.[1] as number) ?? 0;
  }

  private tooManyRequests(res: Response, retryAfter: number): void {
    res.setHeader('Retry-After', String(retryAfter));
    res.status(HttpStatus.TOO_MANY_REQUESTS).json({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please slow down or upgrade your plan.',
      retryAfter,
    });
  }

  private getIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  private normalizePath(path: string): string {
    // Strip UUIDs and numeric IDs for route matching
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+/g, '/:id');
  }
}
