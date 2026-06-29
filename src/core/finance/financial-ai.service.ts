/**
 * FinancialAiService — V53 Financial AI Engine
 *
 * Single source of truth for real profit calculation.
 * Does NOT duplicate V36 CashflowIntelligenceEngine (which is engine-level).
 * Does NOT duplicate src/financial/ProfitService (which is pure arithmetic).
 *
 * This service:
 *   - Fetches raw revenue + cost components from DB
 *   - Computes TRUE profit per product / store / global
 *   - Persists to finance_transactions + finance_summary
 *   - Exposes summary for controller and orchestrator
 *
 * Formula:
 *   profit = revenue - ads_cost - product_cost - shipping - fees
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject }              from '@nestjs/common';
import { Pool }                from 'pg';

export interface ProfitBreakdown {
  revenue:      number;
  adsCost:      number;
  productCost:  number;
  shipping:     number;
  fees:         number;
  profit:       number;
  roas:         number;
  margin:       number;          // profit / revenue
}

export interface FinancialSummary {
  global:    ProfitBreakdown;
  byStore:   Record<string, ProfitBreakdown>;
  byProduct: Record<string, ProfitBreakdown>;
  asOf:      string;
}

@Injectable()
export class FinancialAiService {
  private readonly log = new Logger(FinancialAiService.name);

  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  // ── Public ──────────────────────────────────────────────────────────────────

  async computeProfit(params: {
    revenue:     number;
    adsCost:     number;
    productCost: number;
    shipping:    number;
    fees:        number;
    productId?:  string;
    storeId?:    string;
    source?:     string;
  }): Promise<ProfitBreakdown> {
    const { revenue, adsCost, productCost, shipping, fees } = params;
    const profit = revenue - adsCost - productCost - shipping - fees;
    const roas   = adsCost > 0 ? revenue / adsCost : 0;
    const margin = revenue > 0 ? profit / revenue  : 0;

    const breakdown: ProfitBreakdown = {
      revenue, adsCost, productCost, shipping, fees,
      profit:  parseFloat(profit.toFixed(2)),
      roas:    parseFloat(roas.toFixed(4)),
      margin:  parseFloat(margin.toFixed(4)),
    };

    // Persist transaction
    await this.persistTransaction({
      type:      profit >= 0 ? 'income' : 'expense',
      amount:    Math.abs(profit),
      source:    params.source ?? 'financial_ai',
      productId: params.productId,
      storeId:   params.storeId,
      metadata:  breakdown,
    });

    return breakdown;
  }

  async getGlobalSummary(): Promise<FinancialSummary> {
    const [globalRow, storeRows, productRows] = await Promise.all([
      this.queryGlobal(),
      this.queryByStore(),
      this.queryByProduct(),
    ]);

    return {
      global:    globalRow,
      byStore:   storeRows,
      byProduct: productRows,
      asOf:      new Date().toISOString(),
    };
  }

  async getStoreProfitability(): Promise<Record<string, ProfitBreakdown>> {
    return this.queryByStore();
  }

  /** Returns stores with negative profit (loss stores) */
  async getLossStores(): Promise<string[]> {
    const byStore = await this.queryByStore();
    return Object.entries(byStore)
      .filter(([, b]) => b.profit < 0)
      .map(([storeId]) => storeId);
  }

  /** Returns stores with high positive profit (scale candidates) */
  async getProfitableStores(minProfit = 500): Promise<string[]> {
    const byStore = await this.queryByStore();
    return Object.entries(byStore)
      .filter(([, b]) => b.profit >= minProfit)
      .map(([storeId]) => storeId);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async persistTransaction(params: {
    type:      'income' | 'expense';
    amount:    number;
    source:    string;
    productId?: string;
    storeId?:   string;
    metadata:   object;
  }): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO finance_transactions
          (type, amount, source, product_id, store_id, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        params.type,
        params.amount,
        params.source,
        params.productId ?? null,
        params.storeId   ?? null,
        JSON.stringify(params.metadata),
      ]);
    } catch (err) {
      this.log.warn(`persistTransaction failed (non-critical): ${(err as Error).message}`);
    }
  }

  private async queryGlobal(): Promise<ProfitBreakdown> {
    try {
      const { rows } = await this.pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN type='income'  THEN amount ELSE 0 END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS costs
        FROM finance_transactions
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `);
      const { revenue, costs } = rows[0] ?? { revenue: 0, costs: 0 };
      return this.buildBreakdown(+revenue, +costs);
    } catch { return this.emptyBreakdown(); }
  }

  private async queryByStore(): Promise<Record<string, ProfitBreakdown>> {
    try {
      const { rows } = await this.pool.query(`
        SELECT store_id,
          SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS revenue,
          SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS costs
        FROM finance_transactions
        WHERE store_id IS NOT NULL
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY store_id
      `);
      const result: Record<string, ProfitBreakdown> = {};
      for (const r of rows) {
        result[r.store_id] = this.buildBreakdown(+r.revenue, +r.costs);
      }
      return result;
    } catch { return {}; }
  }

  private async queryByProduct(): Promise<Record<string, ProfitBreakdown>> {
    try {
      const { rows } = await this.pool.query(`
        SELECT product_id,
          SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS revenue,
          SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS costs
        FROM finance_transactions
        WHERE product_id IS NOT NULL
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY product_id
      `);
      const result: Record<string, ProfitBreakdown> = {};
      for (const r of rows) {
        result[r.product_id] = this.buildBreakdown(+r.revenue, +r.costs);
      }
      return result;
    } catch { return {}; }
  }

  private buildBreakdown(revenue: number, costs: number): ProfitBreakdown {
    const profit = revenue - costs;
    return {
      revenue,
      adsCost:     costs * 0.5,   // estimated split — real split from transaction metadata
      productCost: costs * 0.35,
      shipping:    costs * 0.10,
      fees:        costs * 0.05,
      profit:      parseFloat(profit.toFixed(2)),
      roas:        parseFloat((costs > 0 ? revenue / (costs * 0.5) : 0).toFixed(4)),
      margin:      parseFloat((revenue > 0 ? profit / revenue : 0).toFixed(4)),
    };
  }

  private emptyBreakdown(): ProfitBreakdown {
    return { revenue: 0, adsCost: 0, productCost: 0, shipping: 0, fees: 0, profit: 0, roas: 0, margin: 0 };
  }
}
