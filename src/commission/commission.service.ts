/**
 * CommissionService
 *
 * CRITICAL PRIVACY RULE:
 *   The commission amount is NEVER exposed to end-users.
 *   Users only see `minimumAllowedPrice` = supplier_price + commission.
 *   All internal methods are marked @internal and used only by admin/pipeline.
 *
 * Flow:
 *   Supplier Base Price = ₹500
 *   Admin Commission    = ₹100  ← INVISIBLE TO USER
 *   Minimum User Price  = ₹600  ← What the user sees
 *
 * Admin controls:
 *   - enable / disable commission globally
 *   - switch between fixed (₹) or percentage (%)
 *   - set per-category overrides
 */

import {
  Injectable,
  Logger,
  Inject,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as baseSchema from '../common/database/schema';
import * as ext from '../commerce/schema-extensions';

export interface PriceFloor {
  /** Supplier raw cost — admin-only */
  supplierPrice: number;
  /** Hidden commission applied — admin-only */
  commissionAmount: number;
  /** What the user is shown as "minimum allowed price" */
  minimumAllowedPrice: number;
  currency: string;
}

@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  // ── Admin API ─────────────────────────────────────────────────────────────

  /** Create or update the global commission config (admin only). */
  async upsertConfig(adminUserId: string, dto: {
    isEnabled:         boolean;
    commissionType:    'fixed' | 'percentage';
    fixedAmount?:      number;
    percentage?:       number;
    appliedToCategory?: string;
    minOrderValue?:    number;
    notes?:            string;
  }): Promise<typeof ext.commissionConfig.$inferSelect> {
    const [existing] = await this.db
      .select()
      .from(ext.commissionConfig)
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(ext.commissionConfig)
        .set({
          isEnabled:         dto.isEnabled,
          commissionType:    dto.commissionType,
          fixedAmount:       String(dto.fixedAmount ?? 0),
          percentage:        String(dto.percentage  ?? 0),
          appliedToCategory: dto.appliedToCategory ?? null,
          minOrderValue:     String(dto.minOrderValue ?? 0),
          notes:             dto.notes,
          updatedAt:         new Date(),
        })
        .where(eq(ext.commissionConfig.id, existing.id))
        .returning();
      this.logger.log(`Commission config updated by admin ${adminUserId}`);
      return updated;
    }

    const [created] = await this.db
      .insert(ext.commissionConfig)
      .values({
        isEnabled:         dto.isEnabled,
        commissionType:    dto.commissionType,
        fixedAmount:       String(dto.fixedAmount ?? 0),
        percentage:        String(dto.percentage  ?? 0),
        appliedToCategory: dto.appliedToCategory ?? null,
        minOrderValue:     String(dto.minOrderValue ?? 0),
        notes:             dto.notes ?? null,
        createdBy:         adminUserId,
      })
      .returning();

    this.logger.log(`Commission config created by admin ${adminUserId}`);
    return created;
  }

  /** Admin: read current config. */
  async getConfig(): Promise<typeof ext.commissionConfig.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(ext.commissionConfig)
      .limit(1);
    return row ?? null;
  }

  // ── Internal Pipeline API ─────────────────────────────────────────────────

  /**
   * @internal  Used by the commerce pipeline only.
   * Returns the price floor for a product — commission is embedded silently.
   * The caller must NEVER expose commissionAmount or supplierPrice to users.
   */
  async computePriceFloor(
    rawSupplierPrice: number,
    currency: string,
    category?: string,
  ): Promise<PriceFloor> {
    const config = await this.getConfig();

    if (!config || !config.isEnabled) {
      return {
        supplierPrice:       rawSupplierPrice,
        commissionAmount:    0,
        minimumAllowedPrice: rawSupplierPrice,
        currency,
      };
    }

    // Category filter — if config targets a specific category, skip others
    if (config.appliedToCategory && config.appliedToCategory !== category) {
      return {
        supplierPrice:       rawSupplierPrice,
        commissionAmount:    0,
        minimumAllowedPrice: rawSupplierPrice,
        currency,
      };
    }

    let commission = 0;

    if (config.commissionType === 'fixed') {
      commission = parseFloat(config.fixedAmount ?? '0');
    } else {
      const pct = parseFloat(config.percentage ?? '0');
      commission = (rawSupplierPrice * pct) / 100;
    }

    const minimumAllowedPrice = rawSupplierPrice + commission;

    this.logger.debug(
      `Price floor: supplier=₹${rawSupplierPrice} commission=₹${commission.toFixed(2)} ` +
      `minimum=₹${minimumAllowedPrice.toFixed(2)} [INTERNAL — not exposed to user]`,
    );

    return {
      supplierPrice:       rawSupplierPrice,
      commissionAmount:    commission,
      minimumAllowedPrice,
      currency,
    };
  }

  /**
   * Validate that a user-chosen selling price meets the hidden floor.
   * Throws ForbiddenException if the price is below minimum.
   */
  async enforceMinimumPrice(
    userSellingPrice: number,
    rawSupplierPrice: number,
    currency: string,
    category?: string,
  ): Promise<void> {
    const floor = await this.computePriceFloor(rawSupplierPrice, currency, category);

    if (userSellingPrice < floor.minimumAllowedPrice) {
      throw new ForbiddenException(
        `Selling price ₹${userSellingPrice} is below the minimum allowed price ` +
        `of ₹${floor.minimumAllowedPrice.toFixed(2)}.`,
      );
    }
  }

  /**
   * @internal  Returns only what users are allowed to see.
   * Never include commissionAmount or supplierPrice in this output.
   */
  async getUserPriceInfo(
    rawSupplierPrice: number,
    currency: string,
    category?: string,
  ): Promise<{ minimumAllowedPrice: number; currency: string }> {
    const floor = await this.computePriceFloor(rawSupplierPrice, currency, category);
    return {
      minimumAllowedPrice: floor.minimumAllowedPrice,
      currency,
    };
  }

// ── V60 admin alias ─────────────────────────────────────────────────────────
  async setCommissionRate(tenantId: string, rate: number, actorId: string) {
    return this.upsertConfig(actorId, { isEnabled: true, commissionType: 'percentage', percentage: rate });
  }
}
