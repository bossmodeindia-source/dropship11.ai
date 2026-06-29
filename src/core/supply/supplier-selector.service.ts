/**
 * SupplierSelectorService — V51
 *
 * Selects the best available supplier for a given product.
 *
 * Logic:
 *   1. Find all suppliers serving the product's category
 *   2. Score each via SupplierIntelligenceService
 *   3. Pick highest total score
 *   4. Fallback: if selected supplier unavailable → next highest
 *   5. If none available → return null (order not placed)
 *
 * SAFETY: Selection only. No payment. No Meta bypass.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  SupplierIntelligenceService,
  SupplierRecord,
  SupplierScore,
} from './supplier-intelligence.service';

export interface SelectedSupplier {
  supplier:  SupplierRecord;
  score:     SupplierScore;
  isFallback: boolean;
}

@Injectable()
export class SupplierSelectorService {
  private readonly logger = new Logger(SupplierSelectorService.name);

  constructor(
    private readonly intelligence: SupplierIntelligenceService,
  ) {}

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Select the best supplier for a product.
   * @param product  Any object with { category?: string, name?: string }
   * @returns SelectedSupplier or null if no suppliers available
   */
  async selectSupplier(product: {
    category?: string;
    name?: string;
    product_id?: string;
  }): Promise<SelectedSupplier | null> {
    const category = product.category ?? 'general';

    const suppliers = await this.intelligence.loadSuppliers(category);

    if (suppliers.length === 0) {
      // Fallback: try without category filter
      const all = await this.intelligence.loadSuppliers();
      if (all.length === 0) {
        this.logger.warn(`No suppliers available for product ${product.product_id}`);
        return null;
      }
      suppliers.push(...all);
    }

    // Score all candidates
    const scored: { supplier: SupplierRecord; score: SupplierScore }[] = [];
    for (const s of suppliers) {
      const score = await this.intelligence.scoreSupplier(s);
      scored.push({ supplier: s, score });
    }

    // Sort by total score descending
    scored.sort((a, b) => b.score.total - a.score.total);

    // Pick first available
    const primary = scored.find(s => s.score.available);
    if (!primary) {
      this.logger.warn(`All suppliers unavailable for product ${product.product_id}`);
      return null;
    }

    const isFallback = scored[0]?.supplier.id !== primary.supplier.id;

    this.logger.log(
      `Selected supplier "${primary.supplier.name}" ` +
      `(score ${primary.score.total}) for product ${product.product_id ?? product.name}` +
      (isFallback ? ' [FALLBACK]' : ''),
    );

    return { supplier: primary.supplier, score: primary.score, isFallback };
  }
}
