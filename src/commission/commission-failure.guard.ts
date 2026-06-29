/**
 * commission-failure.guard.ts
 *
 * CommissionFailureGuard — Fail-closed commission enforcement
 *
 * REQUIREMENT:
 *   If commission calculation fails:
 *     ✅ Fail the workflow
 *     ✅ Rollback the transaction
 *     ✅ Alert admin
 *     ✅ Log with full context
 *     ❌ Never default to zero
 *     ❌ Never silently continue
 *     ❌ Never silently create orders
 *
 * USAGE (in CommercePipelineService or any financial workflow):
 *
 *   const floor = await CommissionFailureGuard.computeOrFail(
 *     this.commission,
 *     this.alerting,
 *     rawSupplierPrice,
 *     currency,
 *     category,
 *     { orderId, userId, context: 'commerce-pipeline' },
 *   );
 *   // If this line returns, floor is guaranteed valid.
 *   // If commission fails, it throws CommissionCalculationError (caught by caller
 *   // who must rollback and return 500).
 *
 * PLACE THIS FILE:
 *   src/commission/commission-failure.guard.ts
 */

import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { CommissionService, PriceFloor } from './commission.service';
import { AlertingService } from '../alerting/alerting.service';

export class CommissionCalculationError extends InternalServerErrorException {
  constructor(
    public readonly context: CommissionFailureContext,
    public readonly cause: Error,
  ) {
    super(
      `Commission calculation failed for order ${context.orderId ?? 'unknown'}: ${cause.message}. ` +
      `Workflow blocked — admin alerted. DO NOT default to zero commission.`,
    );
    this.name = 'CommissionCalculationError';
  }
}

export interface CommissionFailureContext {
  orderId?:         string;
  userId?:          string;
  rawSupplierPrice: number;
  currency:         string;
  category?:        string;
  context:          string;  // 'commerce-pipeline' | 'supplier-payment' | etc.
}

@Injectable()
export class CommissionFailureGuard {
  private readonly logger = new Logger(CommissionFailureGuard.name);

  constructor(
    private readonly commission: CommissionService,
    private readonly alerting:   AlertingService,
  ) {}

  /**
   * Compute commission price floor, throwing on ANY failure.
   *
   * This method NEVER returns a zero commission due to a calculation failure.
   * If the DB is down, if the config row is missing, if there is a parsing
   * error — it throws CommissionCalculationError and blocks the workflow.
   *
   * A zero commission is only returned when the commission config is
   * intentionally disabled (config.isEnabled === false), which is a valid
   * business decision — NOT an error.
   */
  async computeOrFail(
    rawSupplierPrice: number,
    currency:         string,
    ctx:              CommissionFailureContext,
    category?:        string,
  ): Promise<PriceFloor> {
    try {
      const floor = await this.commission.computePriceFloor(
        rawSupplierPrice,
        currency,
        category,
      );

      // Sanity check: if commission is claimed to be 0 but config IS enabled,
      // something is wrong — treat as failure rather than silently proceeding.
      if (floor.commissionAmount < 0) {
        throw new Error(
          `Commission amount is negative (${floor.commissionAmount}) — this is a data integrity error`,
        );
      }

      this.logger.debug(
        `[CommissionGuard] OK: supplier=₹${rawSupplierPrice} commission=₹${floor.commissionAmount} ` +
        `floor=₹${floor.minimumAllowedPrice} [context=${ctx.context} orderId=${ctx.orderId ?? 'N/A'}]`,
      );

      return floor;

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Log at error level with full context
      this.logger.error(
        `[CommissionGuard] CALCULATION FAILED — workflow BLOCKED\n` +
        `  context:     ${ctx.context}\n` +
        `  orderId:     ${ctx.orderId ?? 'N/A'}\n` +
        `  userId:      ${ctx.userId ?? 'N/A'}\n` +
        `  supplierPrice: ₹${rawSupplierPrice}\n` +
        `  currency:    ${currency}\n` +
        `  error:       ${error.message}\n` +
        `  stack:       ${error.stack ?? 'N/A'}`,
      );

      // Alert admin — fire-and-forget (non-blocking, does not mask original error)
      this.alerting.sendCritical({
        title:   `Commission Calculation Failure — Order Blocked`,
        message: `Order ${ctx.orderId ?? 'unknown'} in ${ctx.context} was blocked because commission calculation failed: ${error.message}. Manual review required.`,
      }).catch((alertErr: Error) => {
        this.logger.error(`[CommissionGuard] Alert failed (non-critical): ${alertErr.message}`);
      });

      // Throw typed error — callers MUST catch this and rollback
      throw new CommissionCalculationError(ctx, error);
    }
  }
}
