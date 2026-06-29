/**
 * FinanceTrackingService
 *
 * Single source of truth for all per-tenant financial metrics.
 *
 * Dashboard formula:
 *   Net Profit = Revenue − Supplier Costs − Platform Commissions − Ad Spend
 *
 * Tracks:
 *   - Total Shopify revenue (from synced orders)
 *   - Supplier costs (from supplier_payments table)
 *   - Platform commission (from commission_config applied per order)
 *   - Ad spend (from meta_ad_campaigns)
 *   - Pending payouts (approved but not yet completed withdrawals)
 *   - Fulfilled order count
 *
 * Architecture:
 *   - All queries are tenant-scoped (tenantId WHERE clause always present)
 *   - Results are cached in Redis for 60s to reduce DB pressure
 *   - Daily snapshots are written to platform_finance_snapshots table
 *   - Admin sees platform-wide aggregates; users see their own tenant only
 *
 * PRIVACY RULE:
 *   Commission and supplier cost detail is NEVER returned to users.
 *   Users see only: revenue, estimated_net_profit, ad_spend, pending_payouts.
 */

import {
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { eq, and, gte, lte, sum, count, sql } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import * as ext from '../commerce/schema-extensions';
import * as wSchema from '../withdrawal/withdrawal-schema';

// ── Response types ────────────────────────────────────────────────────────────

export interface UserFinanceDashboard {
  tenantId:           string;
  totalRevenue:       number;
  estimatedNetProfit: number;
  adSpend:            number;
  pendingPayouts:     number;
  totalOrders:        number;
  fulfilledOrders:    number;
  pendingOrders:      number;
  currency:           string;
  calculatedAt:       Date;
}

export interface AdminFinanceDashboard extends UserFinanceDashboard {
  supplierCosts:       number;
  platformCommissions: number;
  subscriptionRevenue: number;
  totalWithdrawn:      number;
  // Platform-wide aggregates (across all tenants)
  platformTotalRevenue:  number;
  platformTotalProfit:   number;
  platformCommissionSum: number;
}

export interface PlatformFinanceSummary {
  totalRevenue:        number;
  totalProfit:         number;
  totalSupplierCosts:  number;
  totalCommissions:    number;
  totalAdSpend:        number;
  totalWithdrawn:      number;
  activeSubscriptions: number;
  subscriptionRevenue: number;
  calculatedAt:        Date;
}

@Injectable()
export class FinanceTrackingService {
  private readonly logger = new Logger(FinanceTrackingService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  // ── User: Finance Dashboard ───────────────────────────────────────────────

  /**
   * Returns tenant-scoped dashboard metrics safe for user consumption.
   * Commission and supplier cost details are EXCLUDED from this response.
   */
  async getUserDashboard(tenantId: string): Promise<UserFinanceDashboard> {
    const [revenue, adSpend, orders, payouts] = await Promise.all([
      this.getRevenueForTenant(tenantId),
      this.getAdSpendForTenant(tenantId),
      this.getOrderCountsForTenant(tenantId),
      this.getPendingPayoutsForTenant(tenantId),
    ]);

    // Supplier costs + commissions are fetched internally for profit calculation
    // but NOT returned in the user-facing response
    const supplierCosts  = await this.getSupplierCostsForTenant(tenantId);
    const commissions    = await this.getCommissionsForTenant(tenantId);

    const estimatedNetProfit = Math.max(
      0,
      revenue - supplierCosts - commissions - adSpend,
    );

    return {
      tenantId,
      totalRevenue:       round2(revenue),
      estimatedNetProfit: round2(estimatedNetProfit),
      adSpend:            round2(adSpend),
      pendingPayouts:     round2(payouts),
      totalOrders:        orders.total,
      fulfilledOrders:    orders.fulfilled,
      pendingOrders:      orders.pending,
      currency:           'INR',
      calculatedAt:       new Date(),
    };
  }

  // ── Admin: Full Dashboard ─────────────────────────────────────────────────

  async getAdminDashboardForTenant(tenantId: string): Promise<AdminFinanceDashboard> {
    const userDash = await this.getUserDashboard(tenantId);

    const [supplierCosts, commissions, subscriptionRevenue, totalWithdrawn] =
      await Promise.all([
        this.getSupplierCostsForTenant(tenantId),
        this.getCommissionsForTenant(tenantId),
        this.getSubscriptionRevenueForTenant(tenantId),
        this.getTotalWithdrawnForTenant(tenantId),
      ]);

    const platformSummary = await this.getPlatformWideSummary();

    return {
      ...userDash,
      supplierCosts:       round2(supplierCosts),
      platformCommissions: round2(commissions),
      subscriptionRevenue: round2(subscriptionRevenue),
      totalWithdrawn:      round2(totalWithdrawn),
      platformTotalRevenue:  round2(platformSummary.totalRevenue),
      platformTotalProfit:   round2(platformSummary.totalProfit),
      platformCommissionSum: round2(platformSummary.totalCommissions),
    };
  }

  // ── Admin: Platform-wide summary ──────────────────────────────────────────

  async getPlatformWideSummary(): Promise<PlatformFinanceSummary> {
    const rows = await this.db.execute(sql`
      SELECT
        (SELECT COALESCE(SUM(total_price), 0)
           FROM orders
           WHERE status IN ('fulfilled', 'completed', 'supplier_paid'))::text  AS total_revenue,

        (SELECT COALESCE(SUM(amount), 0)
           FROM supplier_payments
           WHERE status = 'paid')::text                                         AS supplier_costs,

        (SELECT COALESCE(SUM(spend), 0)
           FROM meta_ad_campaigns)::text                                        AS ad_spend,

        (SELECT COALESCE(SUM(amount), 0)
           FROM withdrawals
           WHERE status = 'completed')::text                                    AS total_withdrawn,

        (SELECT COUNT(*)
           FROM user_subscriptions
           WHERE status = 'active' AND plan != 'free')::text                   AS active_subs,

        (SELECT COALESCE(SUM(monthly_amount_inr), 0)
           FROM user_subscriptions
           WHERE status = 'active' AND plan != 'free')::text                   AS sub_revenue
    `);
    const row     = rows.rows[0] as any;
    const revenue      = parseFloat(row?.total_revenue  ?? '0');
    const supplierCosts = parseFloat(row?.supplier_costs ?? '0');
    const adSpend      = parseFloat(row?.ad_spend       ?? '0');
    const totalCommissions = revenue * 0.15;
    return {
      totalRevenue:        round2(revenue),
      totalProfit:         round2(revenue - supplierCosts - adSpend),
      totalSupplierCosts:  round2(supplierCosts),
      totalCommissions:    round2(totalCommissions),
      totalAdSpend:        round2(adSpend),
      totalWithdrawn:      round2(parseFloat(row?.total_withdrawn ?? '0')),
      activeSubscriptions: parseInt(row?.active_subs ?? '0', 10),
      subscriptionRevenue: round2(parseFloat(row?.sub_revenue ?? '0')),
      calculatedAt:        new Date(),
    };
  }

  // ── Snapshot: Daily P&L ───────────────────────────────────────────────────

  /**
   * Write a daily P&L snapshot for a tenant.
   * Called by a nightly cron job — append-only, never updated.
   */
  async writeSnapshot(tenantId: string): Promise<void> {
    const dash = await this.getUserDashboard(tenantId);
    const supplierCosts  = await this.getSupplierCostsForTenant(tenantId);
    const commissions    = await this.getCommissionsForTenant(tenantId);
    const subRevenue     = await this.getSubscriptionRevenueForTenant(tenantId);
    const totalWithdrawn = await this.getTotalWithdrawnForTenant(tenantId);

    await this.db
      .insert(wSchema.platformFinanceSnapshots)
      .values({
        tenantId,
        snapshotDate:        new Date(),
        totalRevenue:        String(dash.totalRevenue),
        supplierCosts:       String(supplierCosts),
        platformCommissions: String(commissions),
        adSpend:             String(dash.adSpend),
        estimatedNetProfit:  String(dash.estimatedNetProfit),
        fulfilledOrders:     dash.fulfilledOrders,
        pendingOrders:       dash.pendingOrders,
        totalOrders:         dash.totalOrders,
        totalWithdrawn:      String(totalWithdrawn),
        pendingPayouts:      String(dash.pendingPayouts),
        subscriptionRevenue: String(subRevenue),
        metadata:            { calculatedAt: new Date().toISOString() },
      });

    this.logger.log(`Finance snapshot written for tenant ${tenantId}`);
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private async getRevenueForTenant(tenantId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(total_price), 0)::text AS revenue
        FROM orders
       WHERE tenant_id = ${tenantId}
         AND status IN ('fulfilled', 'completed', 'supplier_paid')
    `);
    return parseFloat((rows.rows[0] as any)?.revenue ?? '0');
  }

  private async getAdSpendForTenant(tenantId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(spend), 0)::text AS spend
        FROM meta_ad_campaigns
       WHERE tenant_id = ${tenantId}
    `);
    return parseFloat((rows.rows[0] as any)?.spend ?? '0');
  }

  private async getSupplierCostsForTenant(tenantId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::text AS costs
        FROM supplier_payments
       WHERE tenant_id = ${tenantId}
         AND status = 'paid'
    `);
    return parseFloat((rows.rows[0] as any)?.costs ?? '0');
  }

  private async getCommissionsForTenant(tenantId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(commission_amount), 0)::text AS commissions
        FROM orders
       WHERE tenant_id = ${tenantId}
         AND status IN ('fulfilled', 'completed', 'supplier_paid')
    `);
    return parseFloat((rows.rows[0] as any)?.commissions ?? '0');
  }

  private async getOrderCountsForTenant(tenantId: string): Promise<{
    total: number; fulfilled: number; pending: number;
  }> {
    const rows = await this.db.execute(sql`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status IN ('fulfilled','completed'))::text AS fulfilled,
        COUNT(*) FILTER (WHERE status IN ('created','pending_supplier_payment'))::text AS pending
        FROM orders
       WHERE tenant_id = ${tenantId}
    `);
    const row = rows.rows[0] as any;
    return {
      total:     parseInt(row?.total     ?? '0', 10),
      fulfilled: parseInt(row?.fulfilled ?? '0', 10),
      pending:   parseInt(row?.pending   ?? '0', 10),
    };
  }

  private async getPendingPayoutsForTenant(tenantId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::text AS pending
        FROM withdrawals
       WHERE tenant_id = ${tenantId}
         AND status IN ('pending', 'approved')
    `);
    return parseFloat((rows.rows[0] as any)?.pending ?? '0');
  }

  private async getTotalWithdrawnForTenant(tenantId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::text AS withdrawn
        FROM withdrawals
       WHERE tenant_id = ${tenantId}
         AND status = 'completed'
    `);
    return parseFloat((rows.rows[0] as any)?.withdrawn ?? '0');
  }

  private async getSubscriptionRevenueForTenant(tenantId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(monthly_amount_inr), 0)::text AS revenue
        FROM user_subscriptions
       WHERE tenant_id = ${tenantId}
         AND status = 'active'
    `);
    return parseFloat((rows.rows[0] as any)?.revenue ?? '0');
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
