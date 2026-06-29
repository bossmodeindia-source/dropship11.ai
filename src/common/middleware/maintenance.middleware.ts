/**
 * MaintenanceMiddleware — Blocks all traffic when in maintenance mode.
 * Returns 503 with Retry-After header.
 */

import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { SystemModeService } from '../../system-mode/system-mode.service';

@Injectable()
export class MaintenanceMiddleware implements NestMiddleware {
  constructor(private readonly systemMode: SystemModeService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.systemMode.isMaintenanceMode()) return next();

    const state = this.systemMode.getState();
    res.setHeader('Retry-After', '300');
    res.setHeader('Content-Type', 'application/json');
    res.status(503).json({
      statusCode: 503,
      error:      'Service Unavailable',
      message:    state.maintenanceMessage ?? 'System is under maintenance. Please try again later.',
      retryAfter: 300,
    });
  }
}
