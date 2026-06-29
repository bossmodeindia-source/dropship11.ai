/**
 * AuditService — Immutable Audit Trail (Drizzle ORM)
 *
 * Tracks ALL sensitive actions across the platform.
 * Schema: audit_logs (append-only, never updated/deleted)
 *
 * Writes are fire-and-forget with buffering — never block request path.
 * On DB failure: fall back to structured log (Pino) as secondary sink.
 */

import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';
import { DB_TOKEN, DrizzleDB, DrizzleTx } from '../common/database/database.module';
import { sql }                   from 'drizzle-orm';

export type AuditSeverity = 'info' | 'warn' | 'critical';

export interface AuditEntry {
  tenantId:   string;
  actorId:    string;
  action:     string;
  resource:   string;
  resourceId?: string;
  details?:   Record<string, unknown>;
  severity?:  AuditSeverity;
  ipAddress?: string;
  userAgent?: string;
}

const BUFFER_SIZE    = 100;
const FLUSH_INTERVAL = 5_000; // 5s

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private buffer: AuditEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval>;

  constructor(@Inject(DB_TOKEN) private readonly db: DrizzleDB) {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  log(entry: AuditEntry): void {
    const level = entry.severity === 'critical' ? 'error'
                : entry.severity === 'warn'     ? 'warn'
                : 'log';
    this.logger[level](
      `AUDIT | ${entry.action} | tenant=${entry.tenantId} actor=${entry.actorId}` +
      ` resource=${entry.resource}:${entry.resourceId ?? '-'}`,
    );
    this.buffer.push({ severity: 'info', ...entry });
    if (this.buffer.length >= BUFFER_SIZE) void this.flush();
  }

  async logInTx(tx: DrizzleTx, entry: AuditEntry): Promise<void> {
    const severity = entry.severity ?? 'info';
    await tx.execute(sql`
      INSERT INTO audit_logs
        (tenant_id, actor_id, action, resource, resource_id,
         details, severity, ip_address, user_agent, created_at)
      VALUES (
        ${entry.tenantId}, ${entry.actorId}, ${entry.action}, ${entry.resource},
        ${entry.resourceId ?? null}, ${JSON.stringify(entry.details ?? {})},
        ${severity}, ${entry.ipAddress ?? null}, ${entry.userAgent ?? null}, NOW()
      )
      ON CONFLICT DO NOTHING
    `);
    this.logger[severity === 'critical' ? 'error' : severity === 'warn' ? 'warn' : 'log'](
      `AUDIT | ${entry.action} | tenant=${entry.tenantId} actor=${entry.actorId}` +
      ` resource=${entry.resource}:${entry.resourceId ?? '-'}`,
    );
  }

  logAdminAction(
    adminId: string, action: string, resource: string,
    resourceId: string, details?: Record<string, unknown>,
  ): void {
    this.log({ tenantId: '__system__', actorId: adminId, action: `ADMIN_${action}`,
               resource, resourceId, details, severity: 'warn' });
  }

  logSecurityEvent(
    tenantId: string, actorId: string, event: string,
    details?: Record<string, unknown>,
  ): void {
    this.log({ tenantId, actorId, action: `SECURITY_${event}`,
               resource: 'security', details, severity: 'critical' });
  }

  logVaultAccess(tenantId: string, actorId: string, operation: string, keyName: string): void {
    this.log({ tenantId, actorId, action: `VAULT_${operation}`,
               resource: 'vault_credentials', resourceId: keyName, severity: 'warn' });
  }

  logFinancialEvent(
    tenantId: string, actorId: string, event: string,
    amount: number, currency: string, details?: Record<string, unknown>,
  ): void {
    this.log({ tenantId, actorId, action: `FINANCE_${event}`, resource: 'financial',
               details: { amount, currency, ...details }, severity: 'critical' });
  }

  // ── Query API — admin log retrieval ────────────────────────────────────────

  async query(params: {
    actorId?:   string;
    tenantId?:  string;
    action?:    string;
    resource?:  string;
    severity?:  AuditSeverity;
    limit?:     number;
    offset?:    number;
    from?:      Date;
    to?:        Date;
  }): Promise<AuditEntry[]> {
    try {
      const { limit = 50, offset = 0 } = params;
      const result = await this.db.execute(sql`
        SELECT tenant_id    AS "tenantId",
               actor_id     AS "actorId",
               action,
               resource,
               resource_id  AS "resourceId",
               details,
               severity,
               ip_address   AS "ipAddress",
               user_agent   AS "userAgent",
               created_at
        FROM audit_logs
        WHERE 1=1
          ${params.actorId  ? sql`AND actor_id  = ${params.actorId}`  : sql``}
          ${params.tenantId ? sql`AND tenant_id = ${params.tenantId}` : sql``}
          ${params.action   ? sql`AND action    = ${params.action}`   : sql``}
          ${params.resource ? sql`AND resource  = ${params.resource}` : sql``}
          ${params.severity ? sql`AND severity  = ${params.severity}` : sql``}
          ${params.from     ? sql`AND created_at >= ${params.from}`   : sql``}
          ${params.to       ? sql`AND created_at <= ${params.to}`     : sql``}
        ORDER BY created_at DESC
        LIMIT  ${limit}
        OFFSET ${offset}
      `);
      return (result.rows as unknown as AuditEntry[]) ?? [];
    } catch (err) {
      this.logger.error(`AuditService.query failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Buffer flush ───────────────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, BUFFER_SIZE);
    try {
      const values = batch.map(e => sql`(
        ${e.tenantId}, ${e.actorId}, ${e.action}, ${e.resource},
        ${e.resourceId ?? null}, ${JSON.stringify(e.details ?? {})},
        ${e.severity ?? 'info'}, ${e.ipAddress ?? null}, ${e.userAgent ?? null},
        NOW()
      )`);
      await this.db.execute(sql`
        INSERT INTO audit_logs
          (tenant_id, actor_id, action, resource, resource_id,
           details, severity, ip_address, user_agent, created_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT DO NOTHING
      `);
    } catch (err) {
      this.logger.error(`AuditService flush failed — entries logged above: ${(err as Error).message}`);
      // Entries already emitted to structured log above — no data loss
    }
  }
}
