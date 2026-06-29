/**
 * AiProviderRegistryService
 *
 * ADMIN-ONLY service for managing the global AI provider catalog.
 *
 * Security model:
 *  - ONLY admins can add / approve / disable / deprecate providers
 *  - Provider approval is audited in ai_provider_approval_log
 *  - Users CANNOT create providers or modify catalog entries
 *  - Users can only READ approved providers to connect their own keys
 *
 * This is the SOLE authority for which AI providers exist in the platform.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import { AuditService } from '../audit/audit.service';
import {
  CreateProviderDto,
  UpdateProviderDto,
  ApproveProviderDto,
} from './dto/provider-registry.dto';

export interface AiProviderCatalogEntry {
  id: string;
  providerKey: string;
  displayName: string;
  category: string;
  description: string | null;
  sdkClass: string | null;
  baseUrl: string | null;
  docsUrl: string | null;
  status: 'pending' | 'approved' | 'disabled' | 'deprecated';
  requiresSecondaryKey: boolean;
  secondaryKeyLabel: string | null;
  capabilities: Record<string, unknown>;
  pricingPerUnit: number | null;
  pricingUnit: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AiProviderRegistryService {
  private readonly logger = new Logger(AiProviderRegistryService.name);

  // In-memory cache of approved providers (refreshed on writes)
  private approvedProvidersCache: AiProviderCatalogEntry[] = [];
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly audit: AuditService,
  ) {}

  // ── Admin: Create Provider ────────────────────────────────────────────────

  async createProvider(
    dto: CreateProviderDto,
    adminId: string,
  ): Promise<AiProviderCatalogEntry> {
    const existing = await this.db.query(
      'SELECT id FROM ai_provider_catalog WHERE provider_key = $1',
      [dto.providerKey],
    );
    if (existing.rows.length > 0) {
      throw new ConflictException(`Provider '${dto.providerKey}' already exists`);
    }

    const result = await this.db.query<AiProviderCatalogEntry>(
      `INSERT INTO ai_provider_catalog (
         provider_key, display_name, category, description, sdk_class,
         base_url, docs_url, status, requires_secondary_key, secondary_key_label,
         health_check_url, capabilities, pricing_per_unit, pricing_unit, sort_order
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        dto.providerKey, dto.displayName, dto.category,
        dto.description ?? null, dto.sdkClass ?? null,
        dto.baseUrl ?? null, dto.docsUrl ?? null,
        dto.requiresSecondaryKey ?? false,
        dto.secondaryKeyLabel ?? null,
        dto.healthCheckUrl ?? null,
        JSON.stringify(dto.capabilities ?? {}),
        dto.pricingPerUnit ?? null, dto.pricingUnit ?? null,
        dto.sortOrder ?? 0,
      ],
    );

    await this.auditProviderAction(result.rows[0].id, adminId, 'submitted', null, 'pending', dto.description);
    this.invalidateCache();

    this.logger.log(`[ADMIN] Provider created: ${dto.providerKey} by admin ${adminId}`);
    return this.mapRow(result.rows[0]);
  }

  // ── Admin: Approve Provider ───────────────────────────────────────────────

  async approveProvider(
    providerId: string,
    dto: ApproveProviderDto,
    adminId: string,
  ): Promise<AiProviderCatalogEntry> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);
    if (provider.status === 'approved') {
      throw new ConflictException('Provider is already approved');
    }

    const result = await this.db.query(
      `UPDATE ai_provider_catalog
       SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [adminId, providerId],
    );

    await this.auditProviderAction(providerId, adminId, 'approved', provider.status, 'approved', dto.notes);
    this.invalidateCache();

    this.logger.log(`[ADMIN] Provider APPROVED: ${provider.provider_key} by admin ${adminId}`);
    return this.mapRow(result.rows[0]);
  }

  // ── Admin: Disable Provider ───────────────────────────────────────────────

  async disableProvider(
    providerId: string,
    reason: string,
    adminId: string,
  ): Promise<void> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    await this.db.query(
      `UPDATE ai_provider_catalog
       SET status = 'disabled', disabled_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [reason, providerId],
    );

    // Also disable all user connections to this provider
    await this.db.query(
      `UPDATE user_ai_provider_connections
       SET connection_status = 'disabled', updated_at = NOW()
       WHERE provider_id = $1 AND is_active = true`,
      [providerId],
    );

    await this.auditProviderAction(providerId, adminId, 'disabled', provider.status, 'disabled', reason);
    this.invalidateCache();

    this.logger.warn(`[ADMIN] Provider DISABLED: ${provider.provider_key} — reason: ${reason}`);
  }

  // ── Admin: Update Provider ────────────────────────────────────────────────

  async updateProvider(
    providerId: string,
    dto: UpdateProviderDto,
    adminId: string,
  ): Promise<AiProviderCatalogEntry> {
    const provider = await this.getProviderByIdRaw(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.displayName !== undefined) { setClauses.push(`display_name = $${idx++}`); values.push(dto.displayName); }
    if (dto.description !== undefined) { setClauses.push(`description = $${idx++}`); values.push(dto.description); }
    if (dto.baseUrl !== undefined)     { setClauses.push(`base_url = $${idx++}`); values.push(dto.baseUrl); }
    if (dto.docsUrl !== undefined)     { setClauses.push(`docs_url = $${idx++}`); values.push(dto.docsUrl); }
    if (dto.capabilities !== undefined){ setClauses.push(`capabilities = $${idx++}`); values.push(JSON.stringify(dto.capabilities)); }
    if (dto.pricingPerUnit !== undefined){ setClauses.push(`pricing_per_unit = $${idx++}`); values.push(dto.pricingPerUnit); }
    if (dto.pricingUnit !== undefined)  { setClauses.push(`pricing_unit = $${idx++}`); values.push(dto.pricingUnit); }
    if (dto.sortOrder !== undefined)    { setClauses.push(`sort_order = $${idx++}`); values.push(dto.sortOrder); }

    if (setClauses.length === 0) return this.mapRow(provider);

    setClauses.push(`updated_at = NOW()`);
    values.push(providerId);

    const result = await this.db.query(
      `UPDATE ai_provider_catalog SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );

    this.invalidateCache();
    this.logger.log(`[ADMIN] Provider updated: ${provider.provider_key} by admin ${adminId}`);
    return this.mapRow(result.rows[0]);
  }

  // ── Public: List Approved Providers (for user connection UI) ─────────────

  async listApprovedProviders(): Promise<AiProviderCatalogEntry[]> {
    if (Date.now() < this.cacheExpiresAt && this.approvedProvidersCache.length > 0) {
      return this.approvedProvidersCache;
    }

    const result = await this.db.query(
      `SELECT * FROM ai_provider_catalog
       WHERE status = 'approved'
       ORDER BY sort_order ASC, display_name ASC`,
    );

    this.approvedProvidersCache = result.rows.map(r => this.mapRow(r));
    this.cacheExpiresAt = Date.now() + this.CACHE_TTL_MS;
    return this.approvedProvidersCache;
  }

  // ── Admin: List All Providers ─────────────────────────────────────────────

  async listAllProviders(): Promise<AiProviderCatalogEntry[]> {
    const result = await this.db.query(
      `SELECT * FROM ai_provider_catalog ORDER BY sort_order ASC, display_name ASC`,
    );
    return result.rows.map(r => this.mapRow(r));
  }

  // ── Validate Provider Is Approved ────────────────────────────────────────

  async assertProviderApproved(providerId: string): Promise<AiProviderCatalogEntry> {
    const result = await this.db.query(
      `SELECT * FROM ai_provider_catalog WHERE id = $1`,
      [providerId],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }
    const provider = this.mapRow(result.rows[0]);
    if (provider.status !== 'approved') {
      throw new ForbiddenException(
        `Provider '${provider.displayName}' is not approved for user connections (status: ${provider.status})`,
      );
    }
    return provider;
  }

  // ── Provider Health Snapshot ──────────────────────────────────────────────

  async recordHealthSnapshot(
    providerId: string,
    status: 'healthy' | 'degraded' | 'down',
    latencyMs: number | null,
    error?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_provider_health_snapshots (provider_id, status, latency_ms, error_message)
       VALUES ($1, $2, $3, $4)`,
      [providerId, status, latencyMs, error ?? null],
    );

    // Prune snapshots older than 7 days
    await this.db.query(
      `DELETE FROM ai_provider_health_snapshots
       WHERE provider_id = $1 AND checked_at < NOW() - INTERVAL '7 days'`,
      [providerId],
    );
  }

  async getProviderHealthSummary(): Promise<
    Array<{ providerId: string; providerKey: string; latestStatus: string; latencyMs: number | null; checkedAt: Date }>
  > {
    const result = await this.db.query(
      `SELECT DISTINCT ON (s.provider_id)
         s.provider_id, c.provider_key, s.status AS latest_status, s.latency_ms, s.checked_at
       FROM ai_provider_health_snapshots s
       JOIN ai_provider_catalog c ON c.id = s.provider_id
       ORDER BY s.provider_id, s.checked_at DESC`,
    );
    return result.rows.map(r => ({
      providerId:    r.provider_id,
      providerKey:   r.provider_key,
      latestStatus:  r.latest_status,
      latencyMs:     r.latency_ms,
      checkedAt:     r.checked_at,
    }));
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private async getProviderByIdRaw(id: string): Promise<any | null> {
    const result = await this.db.query(
      'SELECT * FROM ai_provider_catalog WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  private async auditProviderAction(
    providerId: string,
    adminId: string,
    action: string,
    oldStatus: string | null,
    newStatus: string,
    reason: string | null | undefined,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_provider_approval_log (provider_id, admin_id, action, old_status, new_status, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [providerId, adminId, action, oldStatus, newStatus, reason ?? null],
    );
  }

  private invalidateCache(): void {
    this.approvedProvidersCache = [];
    this.cacheExpiresAt = 0;
  }

  private mapRow(row: any): AiProviderCatalogEntry {
    return {
      id:                   row.id,
      providerKey:          row.provider_key,
      displayName:          row.display_name,
      category:             row.category,
      description:          row.description,
      sdkClass:             row.sdk_class,
      baseUrl:              row.base_url,
      docsUrl:              row.docs_url,
      status:               row.status,
      requiresSecondaryKey: row.requires_secondary_key,
      secondaryKeyLabel:    row.secondary_key_label,
      capabilities:         typeof row.capabilities === 'string'
                              ? JSON.parse(row.capabilities)
                              : (row.capabilities ?? {}),
      pricingPerUnit:       row.pricing_per_unit ? Number(row.pricing_per_unit) : null,
      pricingUnit:          row.pricing_unit,
      approvedBy:           row.approved_by,
      approvedAt:           row.approved_at,
      sortOrder:            row.sort_order,
      createdAt:            row.created_at,
      updatedAt:            row.updated_at,
    };
  }
}
