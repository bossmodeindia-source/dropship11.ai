/**
 * ObservabilityInterceptor — V59 HTTP Request Instrumentation
 *
 * Wraps every request to record:
 *   - Duration (histogram)
 *   - Status code
 *   - Route pattern (normalized, not raw path)
 *   - Tenant ID (from request context)
 *
 * Normalizes paths: /api/v1/bots/uuid-here → /api/v1/bots/:id
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { ObservabilityService } from './observability.service';

const UUID_RE  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUM_RE   = /\/\d+/g;

function normalizePath(path: string): string {
  return path.replace(UUID_RE, ':id').replace(NUM_RE, '/:id');
}

@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ObservabilityInterceptor.name);

  constructor(private readonly obs: ObservabilityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    const http = context.switchToHttp();
    const req  = http.getRequest<Request & { tenantId?: string }>();
    const res  = http.getResponse<Response>();

    const method    = req.method;
    const route     = normalizePath(req.path);
    const tenantId  = req.tenantId;

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        const status   = res.statusCode;
        this.obs.recordHttpRequest(method, route, status, duration, tenantId);
      }),
      catchError(err => {
        const duration = Date.now() - start;
        const status   = err?.status ?? 500;
        this.obs.recordHttpRequest(method, route, status, duration, tenantId);
        return throwError(() => err);
      }),
    );
  }
}
