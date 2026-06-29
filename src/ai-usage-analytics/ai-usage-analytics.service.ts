/**
 * AiUsageAnalyticsService
 *
 * Admin-facing observability service for AI usage across all tenants.
 *
 * Surfaces:
 *  - Per-tenant token/cost/request breakdown
 *  - Per-provider health and cost summary
 *  - Platform-wide usage trends
 *  - Quota violation alerts
 *
 * Data source: user_ai_usage_events (populated by UserAiRouterService)
 * No admin keys are exposed here — this is read-only analytics.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';

export interface TenantUsageSummary {
  tenantId:       string;
  tenantEmail:    string | null;
  totalRequests:  number;
  totalTokens:    number;
  totalCostUsd:   number;
  failedRequests: number;
  avgLatencyMs:   number;
  topProvider:    string | null;
}

export interface ProviderUsageSummary {
  providerKey:    string;
  providerName:   string;
  totalRequests:  number;
  totalTokens:    number;
  totalCostUsd:   number;
  failedRequests: number;
  successRate:    number;
  avgLatencyMs:   number;
  activeTenants:  number;
}

export interface PlatformUsageTrend {
  date:           string;
  totalRequests:  number;
  totalTokens:    number;
  totalCostUsd:   number;
  failedRequests: number;
  activeTenants:  number;
}

@Injectable()
export class AiUsageAnalyticsService {
  private readonly logger = new Logger(AiUsageAnalyticsService.name);

  constructor(@Inject(DB_POOL) private readonly db: Pool) {}

  // ── Admin: platform-wide summary ─────────────────────────────────────────

  async platformSummary(days = 30): Promise<{
    totalRequests:  number;
    totalTokens:    number;
    totalCostUsd:   number;
    failedRequests: number;
    activeTenants:  number;
    activeProviders: number;
  }> {
    const r = await this.db.query(
      `SELECT
         COUNT(*)::int                                AS total_requests,
         COALESCE(SUM(tokens_used),0)::bigint         AS total_tokens,
         COALESCE(SUM(cost_usd),0)::numeric           AS total_cost_usd,
         COUNT(*) FILTER (WHERE success = false)::int AS failed_requests,
         COUNT(DISTINCT tenant_id)::int               AS active_tenants,
         COUNT(DISTINCT provider_key)::int            AS active_providers
       FROM user_ai_usage_events
       WHERE created_at >= NOW() - ($1 || ' days')::interval`,
      [days],
    );
    const row = r.rows[0];
    return {
      totalRequests:  row.total_requests,
      totalTokens:    Number(row.total_tokens),
      totalCostUsd:   Number(row.total_cost_usd),
      failedRequests: row.failed_requests,
      activeTenants:  row.active_tenants,
      activeProviders: row.active_providers,
    };
  }

  // ── Admin: per-tenant breakdown ───────────────────────────────────────────

  async tenantBreakdown(
    days   = 30,
    limit  = 50,
    offset = 0,
  ): Promise<{ items: TenantUsageSummary[]; total: number }> {
    const [rows, countRow] = await Promise.all([
      this.db.query(
        `SELECT
           e.tenant_id,
           u.email                                           AS tenant_email,
           COUNT(*)::int                                     AS total_requests,
           COALESCE(SUM(e.tokens_used),0)::bigint           AS total_tokens,
           COALESCE(SUM(e.cost_usd),0)::numeric             AS total_cost_usd,
           COUNT(*) FILTER (WHERE e.success = false)::int   AS failed_requests,
           COALESCE(AVG(e.latency_ms),0)::int               AS avg_latency_ms,
           MODE() WITHIN GROUP (ORDER BY e.provider_key)    AS top_provider
         FROM user_ai_usage_events e
         LEFT JOIN users u ON u.tenant_id = e.tenant_id
         WHERE e.created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY e.tenant_id, u.email
         ORDER BY total_cost_usd DESC
         LIMIT $2 OFFSET $3`,
        [days, limit, offset],
      ),
      this.db.query(
        `SELECT COUNT(DISTINCT tenant_id)::int AS total
         FROM user_ai_usage_events
         WHERE created_at >= NOW() - ($1 || ' days')::interval`,
        [days],
      ),
    ]);

    return {
      items: rows.rows.map(r => ({
        tenantId:      r.tenant_id,
        tenantEmail:   r.tenant_email,
        totalRequests: r.total_requests,
        totalTokens:   Number(r.total_tokens),
        totalCostUsd:  Number(r.total_cost_usd),
        failedRequests: r.failed_requests,
        avgLatencyMs:  r.avg_latency_ms,
        topProvider:   r.top_provider,
      })),
      total: countRow.rows[0].total,
    };
  }

  // ── Admin: per-provider breakdown ─────────────────────────────────────────

  async providerBreakdown(days = 30): Promise<ProviderUsageSummary[]> {
    const r = await this.db.query(
      `SELECT
         e.provider_key,
         COALESCE(c.display_name, e.provider_key)          AS provider_name,
         COUNT(*)::int                                      AS total_requests,
         COALESCE(SUM(e.tokens_used),0)::bigint            AS total_tokens,
         COALESCE(SUM(e.cost_usd),0)::numeric              AS total_cost_usd,
         COUNT(*) FILTER (WHERE e.success = false)::int    AS failed_requests,
         ROUND(
           100.0 * COUNT(*) FILTER (WHERE e.success = true) / NULLIF(COUNT(*),0),
           2
         )                                                  AS success_rate,
         COALESCE(AVG(e.latency_ms),0)::int                AS avg_latency_ms,
         COUNT(DISTINCT e.tenant_id)::int                  AS active_tenants
       FROM user_ai_usage_events e
       LEFT JOIN ai_provider_catalog c ON c.provider_key = e.provider_key
       WHERE e.created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY e.provider_key, c.display_name
       ORDER BY total_requests DESC`,
      [days],
    );

    return r.rows.map(row => ({
      providerKey:   row.provider_key,
      providerName:  row.provider_name,
      totalRequests: row.total_requests,
      totalTokens:   Number(row.total_tokens),
      totalCostUsd:  Number(row.total_cost_usd),
      failedRequests: row.failed_requests,
      successRate:   Number(row.success_rate ?? 0),
      avgLatencyMs:  row.avg_latency_ms,
      activeTenants: row.active_tenants,
    }));
  }

  // ── Admin: daily trend (last N days) ─────────────────────────────────────

  async dailyTrend(days = 30): Promise<PlatformUsageTrend[]> {
    const r = await this.db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS date,
         COUNT(*)::int                                          AS total_requests,
         COALESCE(SUM(tokens_used),0)::bigint                  AS total_tokens,
         COALESCE(SUM(cost_usd),0)::numeric                    AS total_cost_usd,
         COUNT(*) FILTER (WHERE success = false)::int          AS failed_requests,
         COUNT(DISTINCT tenant_id)::int                        AS active_tenants
       FROM user_ai_usage_events
       WHERE created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY DATE_TRUNC('day', created_at)
       ORDER BY date ASC`,
      [days],
    );

    return r.rows.map(row => ({
      date:          row.date,
      totalRequests: row.total_requests,
      totalTokens:   Number(row.total_tokens),
      totalCostUsd:  Number(row.total_cost_usd),
      failedRequests: row.failed_requests,
      activeTenants: row.active_tenants,
    }));
  }

  // ── Admin: top consumers by cost (used for quota monitoring) ─────────────

  async topConsumers(
    days   = 7,
    limit  = 20,
  ): Promise<Array<{ tenantId: string; tenantEmail: string | null; totalCostUsd: number; totalRequests: number }>> {
    const r = await this.db.query(
      `SELECT
         e.tenant_id,
         u.email                                  AS tenant_email,
         COALESCE(SUM(e.cost_usd),0)::numeric     AS total_cost_usd,
         COUNT(*)::int                            AS total_requests
       FROM user_ai_usage_events e
       LEFT JOIN users u ON u.tenant_id = e.tenant_id
       WHERE e.created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY e.tenant_id, u.email
       ORDER BY total_cost_usd DESC
       LIMIT $2`,
      [days, limit],
    );

    return r.rows.map(row => ({
      tenantId:      row.tenant_id,
      tenantEmail:   row.tenant_email,
      totalCostUsd:  Number(row.total_cost_usd),
      totalRequests: row.total_requests,
    }));
  }

  // ── Admin: quota violation detection ─────────────────────────────────────
  // Returns tenants whose usage_events exceed their connection quota_limit

  async quotaViolations(): Promise<Array<{
    tenantId: string; providerKey: string; quotaLimit: number; quotaUsed: number;
  }>> {
    const r = await this.db.query(
      `SELECT
         c.tenant_id,
         p.provider_key,
         c.quota_limit,
         c.quota_used
       FROM user_ai_provider_connections c
       JOIN ai_provider_catalog p ON p.id = c.provider_id
       WHERE c.quota_limit IS NOT NULL
         AND c.quota_used >= c.quota_limit * 0.9   -- warn at 90%
         AND c.is_active = true
       ORDER BY (c.quota_used::float / NULLIF(c.quota_limit,0)) DESC`,
    );

    return r.rows.map(row => ({
      tenantId:   row.tenant_id,
      providerKey: row.provider_key,
      quotaLimit: Number(row.quota_limit),
      quotaUsed:  Number(row.quota_used),
    }));
  }
}
