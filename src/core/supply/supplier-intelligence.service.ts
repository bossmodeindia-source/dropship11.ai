/**
 * SupplierIntelligenceService — V51
 *
 * Evaluates and scores suppliers.
 *
 * supplier_score =
 *   reliability_score  (0–25)
 *   + delivery_speed   (0–25)
 *   + cost_efficiency  (0–25)
 *   + success_rate     (0–25)
 *   = 0–100
 *
 * Reads from `suppliers` table.
 * Writes score history to `supplier_score_history`.
 * SAFETY: NO payment execution. Read + compute only.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

export interface SupplierRecord {
  id:                string;
  name:              string;
  contact_email:     string;
  categories:        string[];
  country:           string;
  avg_delivery_days: number;
  avg_cost_inr:      number;
  total_orders:      number;
  successful_orders: number;
  active:            boolean;
  meta?:             Record<string, unknown>;
}

export interface SupplierScore {
  supplierId:       string;
  supplierName:     string;
  total:            number;   // 0–100
  reliability:      number;   // 0–25
  deliverySpeed:    number;   // 0–25
  costEfficiency:   number;   // 0–25
  successRate:      number;   // 0–25
  available:        boolean;
  computedAt:       string;
}

// Benchmarks for normalisation
const MAX_DELIVERY_DAYS     = 30;  // 1 day → 25 pts, 30 days → 0 pts
const AVG_MARKET_COST_INR   = 500; // below → better cost efficiency

@Injectable()
export class SupplierIntelligenceService {
  private readonly logger = new Logger(SupplierIntelligenceService.name);

  constructor(private readonly pool: Pool) {}

  // ── Public ────────────────────────────────────────────────────────────────

  async scoreSupplier(supplier: SupplierRecord): Promise<SupplierScore> {
    const reliability   = this.computeReliability(supplier);
    const deliverySpeed = this.computeDeliverySpeed(supplier);
    const costEff       = this.computeCostEfficiency(supplier);
    const successRate   = this.computeSuccessRate(supplier);

    const total = reliability + deliverySpeed + costEff + successRate;

    const score: SupplierScore = {
      supplierId:     supplier.id,
      supplierName:   supplier.name,
      total,
      reliability,
      deliverySpeed,
      costEfficiency: costEff,
      successRate,
      available:      supplier.active,
      computedAt:     new Date().toISOString(),
    };

    await this.persistScore(score);
    return score;
  }

  async scoreAll(category?: string): Promise<SupplierScore[]> {
    const suppliers = await this.loadSuppliers(category);
    return Promise.all(suppliers.map(s => this.scoreSupplier(s)));
  }

  async loadSuppliers(category?: string): Promise<SupplierRecord[]> {
    const query = category
      ? `SELECT * FROM suppliers WHERE active = true AND $1 = ANY(categories) ORDER BY name`
      : `SELECT * FROM suppliers WHERE active = true ORDER BY name`;
    const values = category ? [category] : [];
    const { rows } = await this.pool.query<SupplierRecord>(query, values);
    return rows;
  }

  // ── Scoring helpers ───────────────────────────────────────────────────────

  private computeReliability(s: SupplierRecord): number {
    // Based on historical order history + active status
    if (!s.active) return 0;
    const base = 20; // baseline for being active
    const bonus = s.total_orders >= 100 ? 5 : s.total_orders >= 50 ? 3 : s.total_orders >= 10 ? 1 : 0;
    return Math.min(25, base + bonus);
  }

  private computeDeliverySpeed(s: SupplierRecord): number {
    const days = Math.max(1, s.avg_delivery_days ?? MAX_DELIVERY_DAYS);
    return Math.round(((MAX_DELIVERY_DAYS - days) / (MAX_DELIVERY_DAYS - 1)) * 25);
  }

  private computeCostEfficiency(s: SupplierRecord): number {
    if (!s.avg_cost_inr || s.avg_cost_inr <= 0) return 12; // neutral
    const ratio = AVG_MARKET_COST_INR / s.avg_cost_inr;
    return Math.min(25, Math.round(ratio * 15));
  }

  private computeSuccessRate(s: SupplierRecord): number {
    if (!s.total_orders || s.total_orders === 0) return 12; // neutral
    const rate = (s.successful_orders ?? 0) / s.total_orders;
    return Math.round(rate * 25);
  }

  private async persistScore(score: SupplierScore): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO supplier_score_history
           (supplier_id, total_score, reliability, delivery_speed, cost_efficiency, success_rate, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          score.supplierId,
          score.total,
          score.reliability,
          score.deliverySpeed,
          score.costEfficiency,
          score.successRate,
          score.computedAt,
        ],
      );
    } catch (err) {
      this.logger.warn(`Score persist failed: ${(err as Error).message}`);
    }
  }
}
