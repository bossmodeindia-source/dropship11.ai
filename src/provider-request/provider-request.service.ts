/**
 * ProviderRequestService
 *
 * Handles the full provider request lifecycle:
 *   User submits request → Admin reviews → If approved, provider is added
 *   to ai_provider_catalog (or admin does so separately).
 *
 * Uses the `ai_provider_requests` table from migration 006.
 *
 * SECURITY:
 *  - Users see only their own requests.
 *  - Admins see all requests.
 *  - No user can approve their own request.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import { AuditService } from '../audit/audit.service';
import { SubmitProviderRequestDto, ReviewProviderRequestDto } from './provider-request.dto';

export interface ProviderRequest {
  id:              string;
  tenantId:        string;
  providerName:    string;
  providerUrl:     string | null;
  docsUrl:         string | null;
  category:        string;
  useCase:         string;
  estimatedPricing: string | null;
  status:          'pending' | 'under_review' | 'approved' | 'rejected';
  adminNote:       string | null;
  reviewedBy:      string | null;
  reviewedAt:      Date | null;
  createdAt:       Date;
  updatedAt:       Date;
}

@Injectable()
export class ProviderRequestService {
  private readonly logger = new Logger(ProviderRequestService.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly audit: AuditService,
  ) {}

  // ── USER: submit a provider request ──────────────────────────────────────

  async submit(tenantId: string, dto: SubmitProviderRequestDto): Promise<ProviderRequest> {
    // Prevent duplicate pending requests for the same provider name per tenant
    const dup = await this.db.query(
      `SELECT id FROM ai_provider_requests
       WHERE tenant_id = $1
         AND LOWER(provider_name) = LOWER($2)
         AND status IN ('pending','under_review')`,
      [tenantId, dto.providerName],
    );
    if (dup.rows.length > 0) {
      throw new ConflictException(
        `You already have an open request for "${dto.providerName}". ` +
        `Request ID: ${dup.rows[0].id}`,
      );
    }

    const r = await this.db.query(
      `INSERT INTO ai_provider_requests
         (tenant_id, provider_name, provider_url, docs_url, category,
          use_case, estimated_pricing, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       RETURNING *`,
      [
        tenantId,
        dto.providerName,
        dto.providerUrl   ?? null,
        dto.docsUrl       ?? null,
        dto.category,
        dto.useCase,
        dto.estimatedPricing ?? null,
      ],
    );

    await this.audit.log({
      tenantId,
      actorId:     tenantId,
      action:      'provider_request.submitted',
      resource:    'ai_provider_requests',
      resourceId:  r.rows[0].id,
      details: {
        targetType:   'ai_provider_request',
        providerName: dto.providerName,
        category:     dto.category,
      },
    });

    this.logger.log(`Tenant ${tenantId} submitted provider request for "${dto.providerName}"`);
    return this.mapRow(r.rows[0]);
  }

  // ── USER: list own requests ───────────────────────────────────────────────

  async listForTenant(
    tenantId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: ProviderRequest[]; total: number }> {
    const limit  = Math.min(opts.limit  ?? 20, 100);
    const offset = opts.offset ?? 0;

    const [items, count] = await Promise.all([
      this.db.query(
        `SELECT * FROM ai_provider_requests
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset],
      ),
      this.db.query(
        'SELECT COUNT(*)::int AS total FROM ai_provider_requests WHERE tenant_id = $1',
        [tenantId],
      ),
    ]);

    return {
      items: items.rows.map(this.mapRow),
      total: count.rows[0].total,
    };
  }

  // ── USER: get single own request ──────────────────────────────────────────

  async getForTenant(tenantId: string, id: string): Promise<ProviderRequest> {
    const r = await this.db.query(
      'SELECT * FROM ai_provider_requests WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    if (!r.rows[0]) throw new NotFoundException('Provider request not found');
    return this.mapRow(r.rows[0]);
  }

  // ── USER: cancel own pending request ─────────────────────────────────────

  async cancel(tenantId: string, id: string): Promise<ProviderRequest> {
    const existing = await this.getForTenant(tenantId, id);
    if (existing.status !== 'pending') {
      throw new ConflictException(`Cannot cancel a request with status "${existing.status}"`);
    }

    const r = await this.db.query(
      `UPDATE ai_provider_requests
       SET status = 'rejected', admin_note = 'Cancelled by user', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId],
    );

    await this.audit.log({
      tenantId,
      actorId:     tenantId,
      action:     'provider_request.cancelled',
      resource:   'ai_provider_requests',
      resourceId: id,
      details: { targetType: 'ai_provider_request' },
    });

    return this.mapRow(r.rows[0]);
  }

  // ── ADMIN: list all requests ──────────────────────────────────────────────

  async adminList(opts: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: ProviderRequest[]; total: number }> {
    const limit  = Math.min(opts.limit  ?? 50, 200);
    const offset = opts.offset ?? 0;

    const whereClauses: string[] = [];
    const params: any[] = [];

    if (opts.status) {
      params.push(opts.status);
      whereClauses.push(`status = $${params.length}`);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [items, count] = await Promise.all([
      this.db.query(
        `SELECT r.*, u.email AS tenant_email
         FROM ai_provider_requests r
         LEFT JOIN users u ON u.tenant_id = r.tenant_id
         ${where}
         ORDER BY
           CASE status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,
           created_at ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      this.db.query(
        `SELECT COUNT(*)::int AS total FROM ai_provider_requests ${where}`,
        params,
      ),
    ]);

    return {
      items: items.rows.map(this.mapRow),
      total: count.rows[0].total,
    };
  }

  // ── ADMIN: mark as under_review ───────────────────────────────────────────

  async markUnderReview(adminId: string, id: string): Promise<ProviderRequest> {
    const r = await this.db.query(
      `UPDATE ai_provider_requests
       SET status = 'under_review', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id],
    );
    if (!r.rows[0]) throw new NotFoundException('Pending request not found');

    await this.audit.log({
      tenantId:   r.rows[0].tenant_id,
      actorId:    adminId,
      action:     'provider_request.under_review',
      resource:   'ai_provider_requests',
      resourceId: id,
      details: {
        targetType: 'ai_provider_request',
        adminId,
      },
    });

    return this.mapRow(r.rows[0]);
  }

  // ── ADMIN: approve or reject ──────────────────────────────────────────────

  async review(
    adminId:  string,
    id:       string,
    dto:      ReviewProviderRequestDto,
  ): Promise<ProviderRequest> {
    const r = await this.db.query(
      `UPDATE ai_provider_requests
       SET status       = $1,
           admin_note   = $2,
           reviewed_by  = $3,
           reviewed_at  = NOW(),
           updated_at   = NOW()
       WHERE id = $4 AND status IN ('pending','under_review')
       RETURNING *`,
      [dto.decision, dto.adminNote, adminId, id],
    );
    if (!r.rows[0]) throw new NotFoundException('Reviewable request not found');

    const row = r.rows[0];

    // If approved + providerKey provided, auto-seed the catalog entry
    if (dto.decision === 'approved' && dto.providerKey) {
      const exists = await this.db.query(
        'SELECT id FROM ai_provider_catalog WHERE provider_key = $1',
        [dto.providerKey],
      );
      if (exists.rows.length === 0) {
        await this.db.query(
          `INSERT INTO ai_provider_catalog
             (provider_key, display_name, category, description, status, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,'approved',$5,NOW())
           ON CONFLICT (provider_key) DO NOTHING`,
          [dto.providerKey, row.provider_name, row.category, row.use_case, adminId],
        );
        this.logger.log(`Auto-seeded provider catalog entry for key="${dto.providerKey}"`);
      }
    }

    await this.audit.log({
      tenantId:   row.tenant_id,
      actorId:    adminId,
      action:     `provider_request.${dto.decision}`,
      resource:   'ai_provider_requests',
      resourceId: id,
      details: {
        targetType:  'ai_provider_request',
        adminId,
        adminNote:   dto.adminNote,
        providerKey: dto.providerKey,
      },
    });

    this.logger.log(
      `Admin ${adminId} ${dto.decision} provider request ${id} (${row.provider_name})`,
    );
    return this.mapRow(r.rows[0]);
  }

  // ── ADMIN: summary stats for dashboard ───────────────────────────────────

  async adminStats(): Promise<Record<string, number>> {
    const r = await this.db.query(
      `SELECT status, COUNT(*)::int AS cnt
       FROM ai_provider_requests
       GROUP BY status`,
    );
    const stats: Record<string, number> = {
      pending: 0, under_review: 0, approved: 0, rejected: 0,
    };
    for (const row of r.rows) stats[row.status] = row.cnt;
    return stats;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private mapRow(row: any): ProviderRequest {
    return {
      id:               row.id,
      tenantId:         row.tenant_id,
      providerName:     row.provider_name,
      providerUrl:      row.provider_url,
      docsUrl:          row.docs_url,
      category:         row.category,
      useCase:          row.use_case,
      estimatedPricing: row.estimated_pricing,
      status:           row.status,
      adminNote:        row.admin_note,
      reviewedBy:       row.reviewed_by,
      reviewedAt:       row.reviewed_at,
      createdAt:        row.created_at,
      updatedAt:        row.updated_at,
    };
  }
}
