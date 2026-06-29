/**
 * ShopifyRevenueService — V17: SQL Injection Fix + Confirmed Revenue Logic
 *
 * AUDIT FIX (P3):
 *   getBatchCampaignRevenue() built raw SQL with manual quote escaping:
 *   `'${id.replace(/'/g, "''")}'` — Unicode/hex injection bypasses this.
 *
 *   FIX: Use PostgreSQL ANY($1) parameterized array binding.
 *   FIX: UUID validation whitelist before any query.
 *
 * ABSOLUTE TRUTH RULE (unchanged):
 *   revenue = null means NO DATA (not zero).
 *   System NEVER invents revenue. Missing data → HOLD.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { DB_TOKEN, POOL_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export interface CampaignRevenue {
  campaignId:    string;
  revenue:       number | null;
  unitsSold:     number;
  orderCount:    number;
  avgOrderValue: number | null;
  dataSource:    'shopify_orders' | 'no_data';
  dataQuality:   'REAL' | 'MISSING';
}

export interface RevenueWindow {
  hourly: number | null;
  daily:  number | null;
  total:  number | null;
}

// UUID v4 pattern — campaign IDs must be UUIDs
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ShopifyRevenueService {
  private readonly logger = new Logger(ShopifyRevenueService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(POOL_TOKEN)
    private readonly pool: Pool,
  ) {}

  async getCampaignRevenue(campaignId: string): Promise<CampaignRevenue> {
    if (!UUID_RE.test(campaignId)) {
      this.logger.warn(`[ShopifyRevenue] Invalid campaign ID format: ${campaignId}`);
      return this.noData(campaignId);
    }

    try {
      const rows = await this.db.execute(sql`
        SELECT
          COALESCE(SUM(o.total_price), 0)::float  AS revenue,
          COALESCE(COUNT(o.id), 0)::int            AS order_count,
          COALESCE(SUM(oi.quantity), 0)::int       AS units_sold
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.campaign_id = ${campaignId}
          AND o.status NOT IN ('cancelled', 'refunded', 'failed')
          AND o.source = 'shopify'
      `) as unknown as Array<{ revenue: string; order_count: string; units_sold: string }>;

      const row        = rows[0];
      const orderCount = parseInt(row?.order_count ?? '0', 10);

      if (orderCount === 0) {
        return {
          campaignId, revenue: null, unitsSold: 0, orderCount: 0,
          avgOrderValue: null, dataSource: 'no_data', dataQuality: 'MISSING',
        };
      }

      const revenue   = parseFloat(row.revenue ?? '0');
      const unitsSold = parseInt(row.units_sold ?? '0', 10);

      return {
        campaignId, revenue, unitsSold, orderCount,
        avgOrderValue: parseFloat((revenue / orderCount).toFixed(2)),
        dataSource: 'shopify_orders', dataQuality: 'REAL',
      };
    } catch (err) {
      this.logger.error(`[ShopifyRevenue] DB error for ${campaignId}: ${(err as Error).message}`);
      return this.noData(campaignId);
    }
  }

  /**
   * Batch revenue fetch — V17: parameterized ANY($1) replaces manual SQL escaping.
   * UUID validation whitelists all IDs before query execution.
   */
  async getBatchCampaignRevenue(campaignIds: string[]): Promise<Map<string, CampaignRevenue>> {
    const result = new Map<string, CampaignRevenue>();
    if (!campaignIds.length) return result;

    // V17 FIX: Validate all IDs are UUIDs before building any query
    const safeIds = campaignIds.filter(id => {
      const valid = UUID_RE.test(id);
      if (!valid) this.logger.warn(`[ShopifyRevenue] Rejected non-UUID campaign ID: ${id}`);
      return valid;
    });

    // Initialize all as no_data (safe default)
    for (const id of campaignIds) result.set(id, this.noData(id));
    if (!safeIds.length) return result;

    try {
      // V17 FIX: Use pg Pool with parameterized ANY($1::uuid[]) — no string interpolation
      const { rows } = await this.pool.query<{
        campaign_id: string;
        revenue:     string;
        order_count: string;
        units_sold:  string;
      }>(`
        SELECT
          o.campaign_id,
          SUM(o.total_price)::float    AS revenue,
          COUNT(o.id)::int             AS order_count,
          SUM(oi.quantity)::int        AS units_sold
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.campaign_id = ANY($1::uuid[])
          AND o.status NOT IN ('cancelled', 'refunded', 'failed')
          AND o.source = 'shopify'
        GROUP BY o.campaign_id
      `, [safeIds]);

      for (const row of rows) {
        const orderCount = parseInt(row.order_count ?? '0', 10);
        const revenue    = orderCount > 0 ? parseFloat(row.revenue ?? '0') : null;
        const unitsSold  = parseInt(row.units_sold ?? '0', 10);

        result.set(row.campaign_id, {
          campaignId:   row.campaign_id,
          revenue,
          unitsSold,
          orderCount,
          avgOrderValue: orderCount > 0 && revenue !== null
            ? parseFloat((revenue / orderCount).toFixed(2)) : null,
          dataSource:  orderCount > 0 ? 'shopify_orders' : 'no_data',
          dataQuality: orderCount > 0 ? 'REAL' : 'MISSING',
        });
      }
    } catch (err) {
      this.logger.error(`[ShopifyRevenue] Batch query error: ${(err as Error).message}`);
    }

    return result;
  }

  async getRevenueWindow(campaignId: string): Promise<RevenueWindow> {
    if (!UUID_RE.test(campaignId)) return { hourly: null, daily: null, total: null };
    try {
      const rows = await this.db.execute(sql`
        SELECT
          SUM(CASE WHEN o.created_at >= NOW() - INTERVAL '1 hour'   THEN o.total_price ELSE 0 END)::float AS hourly,
          SUM(CASE WHEN o.created_at >= NOW() - INTERVAL '24 hours' THEN o.total_price ELSE 0 END)::float AS daily,
          SUM(o.total_price)::float AS total
        FROM orders o
        WHERE o.campaign_id = ${campaignId}
          AND o.status NOT IN ('cancelled', 'refunded', 'failed')
          AND o.source = 'shopify'
      `) as unknown as Array<{ hourly: string; daily: string; total: string }>;

      const row   = rows[0];
      const total = parseFloat(row?.total ?? '0');
      return {
        hourly: total > 0 ? parseFloat(row?.hourly ?? '0') : null,
        daily:  total > 0 ? parseFloat(row?.daily  ?? '0') : null,
        total:  total > 0 ? total : null,
      };
    } catch {
      return { hourly: null, daily: null, total: null };
    }
  }

  async getTotalDailyRevenue(): Promise<number> {
    try {
      const rows = await this.db.execute(sql`
        SELECT COALESCE(SUM(total_price), 0)::float AS total
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND status NOT IN ('cancelled', 'refunded', 'failed')
          AND source = 'shopify'
      `) as unknown as Array<{ total: string }>;
      return parseFloat(rows[0]?.total ?? '0');
    } catch {
      return 0;
    }
  }

  private noData(campaignId: string): CampaignRevenue {
    return {
      campaignId, revenue: null, unitsSold: 0, orderCount: 0,
      avgOrderValue: null, dataSource: 'no_data', dataQuality: 'MISSING',
    };
  }
}
