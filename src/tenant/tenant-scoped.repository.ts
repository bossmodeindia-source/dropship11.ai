/**
 * TenantScopedRepository — V59 DB-Level Tenant Isolation
 *
 * ALL database reads/writes for tenant-owned resources MUST go through
 * this base class. It automatically injects `tenant_id = $N` into every
 * query, making cross-tenant data leaks structurally impossible.
 *
 * Usage:
 *   class BotsRepository extends TenantScopedRepository {
 *     async findById(tenantId: string, botId: string) {
 *       return this.findOne(tenantId, 'bots', 'id', botId);
 *     }
 *   }
 */

import { Injectable, Inject, ForbiddenException, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DB_POOL } from '../common/database/database.module';

export interface TenantRow {
  tenant_id: string;
  [key: string]: unknown;
}

@Injectable()
export class TenantScopedRepository {
  protected readonly logger = new Logger(TenantScopedRepository.name);

  constructor(@Inject(DB_POOL) protected readonly db: Pool) {}

  // ── Core scoped queries ────────────────────────────────────────────────────

  /** SELECT * FROM table WHERE tenant_id = $1 AND id = $2 */
  protected async findOne<T extends TenantRow>(
    tenantId: string,
    table: string,
    idColumn: string,
    id: string,
  ): Promise<T | null> {
    this.assertTenant(tenantId);
    const res = await this.db.query<T>(
      `SELECT * FROM ${table} WHERE tenant_id = $1 AND ${idColumn} = $2 LIMIT 1`,
      [tenantId, id],
    );
    return res.rows[0] ?? null;
  }

  /** SELECT * FROM table WHERE tenant_id = $1 [+ extra conditions] */
  protected async findMany<T extends TenantRow>(
    tenantId: string,
    table: string,
    extraWhere = '',
    params: unknown[] = [],
    opts?: { limit?: number; offset?: number; orderBy?: string },
  ): Promise<T[]> {
    this.assertTenant(tenantId);
    const { limit = 50, offset = 0, orderBy = 'created_at DESC' } = opts ?? {};
    const where = extraWhere ? `AND ${extraWhere}` : '';
    const res = await this.db.query<T>(
      `SELECT * FROM ${table}
       WHERE tenant_id = $1 ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
      [tenantId, ...params, limit, offset],
    );
    return res.rows;
  }

  /** Count rows belonging to a tenant */
  protected async count(
    tenantId: string,
    table: string,
    extraWhere = '',
    params: unknown[] = [],
  ): Promise<number> {
    this.assertTenant(tenantId);
    const where = extraWhere ? `AND ${extraWhere}` : '';
    const res = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = $1 ${where}`,
      [tenantId, ...params],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }

  /** INSERT with tenant_id injected automatically */
  protected async insert<T extends TenantRow>(
    tenantId: string,
    table: string,
    data: Omit<T, 'tenant_id'>,
  ): Promise<T> {
    this.assertTenant(tenantId);
    const record = { ...data, tenant_id: tenantId };
    const columns = Object.keys(record);
    const values = Object.values(record);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const res = await this.db.query<T>(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values,
    );
    return res.rows[0];
  }

  /** UPDATE with tenant_id in WHERE clause (prevents cross-tenant writes) */
  protected async update<T extends TenantRow>(
    tenantId: string,
    table: string,
    idColumn: string,
    id: string,
    data: Partial<Omit<T, 'tenant_id' | 'id'>>,
  ): Promise<T | null> {
    this.assertTenant(tenantId);
    const entries = Object.entries(data);
    if (entries.length === 0) return this.findOne<T>(tenantId, table, idColumn, id);
    const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const values = entries.map(([, v]) => v);
    const res = await this.db.query<T>(
      `UPDATE ${table} SET ${sets}, updated_at = NOW()
       WHERE tenant_id = $1 AND ${idColumn} = $2
       RETURNING *`,
      [tenantId, id, ...values],
    );
    return res.rows[0] ?? null;
  }

  /** DELETE scoped to tenant */
  protected async delete(
    tenantId: string,
    table: string,
    idColumn: string,
    id: string,
  ): Promise<boolean> {
    this.assertTenant(tenantId);
    const res = await this.db.query(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND ${idColumn} = $2`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Run a tenant-scoped transaction */
  protected async withTransaction<T>(
    tenantId: string,
    fn: (client: PoolClient, tenantId: string) => Promise<T>,
  ): Promise<T> {
    this.assertTenant(tenantId);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client, tenantId);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Safety checks ──────────────────────────────────────────────────────────

  /** Throw if a row's tenant_id doesn't match the active tenant. */
  assertOwnership(row: TenantRow | null, tenantId: string, resource: string): asserts row is TenantRow {
    if (!row) {
      throw new ForbiddenException(`${resource} not found`);
    }
    if (row.tenant_id !== tenantId) {
      // Log security violation — this should NEVER happen if queries use TenantScopedRepository
      this.logger.error(
        `TENANT ISOLATION VIOLATION: tenant ${tenantId} tried to access ${resource} owned by ${row.tenant_id}`,
      );
      throw new ForbiddenException(`Access denied to ${resource}`);
    }
  }

  private assertTenant(tenantId: string): void {
    if (!tenantId || tenantId.trim() === '') {
      throw new ForbiddenException('No tenant context — cannot execute scoped query');
    }
  }
}
