/**
 * InputValidationGuard — V4 SECURITY HARDENING
 *
 * Prevents SQL injection, parameter tampering, and untrusted
 * campaign IDs from external sources.
 *
 * Rules:
 *   - All campaign IDs must be valid UUIDs
 *   - All numeric inputs validated as non-negative finite
 *   - No raw SQL string interpolation from external inputs
 *   - API inputs validated before reaching any service
 */

import {
  Injectable, CanActivate, ExecutionContext,
  BadRequestException, Logger,
} from '@nestjs/common';

@Injectable()
export class InputValidationGuard implements CanActivate {
  private readonly logger = new Logger(InputValidationGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req    = context.switchToHttp().getRequest();
    const params = req.params ?? {};
    const body   = req.body   ?? {};
    const query  = req.query  ?? {};

    // Validate all campaign IDs in params
    if (params.campaignId && !isValidUuid(params.campaignId)) {
      this.logger.warn(`[Security] Invalid campaignId rejected: ${params.campaignId}`);
      throw new BadRequestException('Invalid campaign ID format');
    }

    if (params.id && !isValidUuid(params.id)) {
      this.logger.warn(`[Security] Invalid id rejected: ${params.id}`);
      throw new BadRequestException('Invalid ID format');
    }

    // Validate numeric body fields
    const numericFields = ['adSpend', 'budget', 'dailyBudget', 'supplierPrice', 'sellingPrice'];
    for (const field of numericFields) {
      if (body[field] !== undefined) {
        const val = parseFloat(body[field]);
        if (!isFinite(val) || val < 0) {
          throw new BadRequestException(`Invalid ${field}: must be non-negative finite number`);
        }
      }
    }

    // Reject suspicious strings in query params
    const suspiciousPatterns = /['";\/*-]/;
    for (const [key, val] of Object.entries(query)) {
      if (typeof val === 'string' && suspiciousPatterns.test(val)) {
        this.logger.warn(`[Security] Suspicious query param rejected: ${key}=${val}`);
        throw new BadRequestException(`Invalid characters in query parameter: ${key}`);
      }
    }

    return true;
  }
}

// ── Standalone validators (used across services) ──────────────────────────────

export function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function sanitizeCampaignId(id: string): string {
  if (!isValidUuid(id)) {
    throw new BadRequestException(`Campaign ID "${id.substring(0, 20)}" is not a valid UUID`);
  }
  return id;
}

export function sanitizeNumeric(val: unknown, field: string): number {
  const n = parseFloat(String(val));
  if (!isFinite(n) || n < 0) {
    throw new BadRequestException(`${field} must be a non-negative finite number`);
  }
  return n;
}

export function sanitizeCategory(cat: string): string {
  // Allow only alphanumeric, hyphens, spaces
  if (!/^[a-z0-9\-\s]{1,50}$/i.test(cat)) {
    throw new BadRequestException('Invalid category format');
  }
  return cat.toLowerCase().trim();
}
