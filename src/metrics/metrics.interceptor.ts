import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req  = context.switchToHttp().getRequest<Request>();
    const res  = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    // Normalize route path (strip dynamic segments for cardinality control)
    const route = this.normalizeRoute(req.route?.path ?? req.path);

    return next.handle().pipe(
      tap({
        next: () => {
          this.metrics.recordHttpRequest(req.method, route, res.statusCode, Date.now() - start);
        },
        error: () => {
          this.metrics.recordHttpRequest(req.method, route, res.statusCode || 500, Date.now() - start);
        },
      }),
    );
  }

  private normalizeRoute(path: string): string {
    // Replace UUIDs and numeric IDs with :id to prevent cardinality explosion
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+/g, '/:id');
  }
}
