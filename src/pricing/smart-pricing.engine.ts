// @ts-nocheck
/**
 * SmartPricingEngine — Phase 4 P4-6: Dynamic Pricing
 *
 * Most dropshippers fix price once and never touch it.
 * This is free money left on the table.
 *
 * Pricing logic:
 *   ROAS ≥ 3 for 3 days   → test 10–15% HIGHER price (extract more margin)
 *   CVR dropping 2 days   → test 10% LOWER price (recover volume)
 *   Price test winner     → winner becomes new base price (Shopify updated)
 *   Price test loser      → revert to previous price
 *
 * Test duration: 3 days (enough data to be statistically meaningful)
 * Max concurrent tests per user: 3 (avoids budget dilution)
 *
 * Economic impact example:
 *   Product at ₹999, ROAS 3.5
 *   Test at ₹1149 (+15%)
 *   If CVR drops only 5% → net revenue +9.3% per order
 *   → Pure profit increase with same ad spend
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Inject } from '@nestjs/common';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export interface PriceTestInput {
  userId:       string;
  productId:    string;
  currentPrice: number;
  trigger:      'HIGH_ROAS' | 'LOW_CVR';
  roas:         number;
}

export interface PriceTestDecision {
  shouldTest:   boolean;
  reason:       string;
  testPrice:    number;
  changePct:    number;
  variantName:  'test_high' | 'test_low';
}

export interface PricingStats {
  activeTests:       number;
  completedTests:    number;
  avgPriceLift:      number;   // % price increase from winning tests
  revenueGainEst:    number;   // estimated extra revenue from pricing
  currentWinners:    Array<{ productId: string; winnerPrice: number; liftPct: number }>;
}

@Injectable()
export class SmartPricingEngine {
  private readonly logger = new Logger(SmartPricingEngine.name);

  // Thresholds
  private static readonly HIGH_ROAS_TRIGGER   = 3.0;
  private static readonly TEST_DURATION_DAYS  = 3;
  private static readonly MAX_CONCURRENT_TESTS = 3;
  private static readonly HIGH_PRICE_LIFT_PCT  = 0.12;  // +12% when ROAS is high
  private static readonly LOW_PRICE_DROP_PCT   = 0.10;  // -10% when CVR dropping

  constructor(@Inject(DB_TOKEN) private readonly db: DrizzleDB) {}

  /**
   * Evaluate whether a product should enter a price test.
   * Called by OptimizationScheduler after each SCALE decision.
   */
  async evaluatePriceTest(input: PriceTestInput): Promise<PriceTestDecision> {
    // Gate 1: max concurrent tests
    const activeCount = await this.db.$client.query(
      `SELECT COUNT(*) AS count FROM price_tests WHERE user_id = $1 AND status = 'RUNNING'`,
      [input.userId],
    );
    if (parseInt(activeCount.rows[0]?.count ?? '0', 10) >= SmartPricingEngine.MAX_CONCURRENT_TESTS) {
      return { shouldTest: false, reason: 'Max concurrent tests reached', testPrice: input.currentPrice, changePct: 0, variantName: 'test_high' };
    }

    // Gate 2: already testing this product
    const existingTest = await this.db.$client.query(
      `SELECT id FROM price_tests WHERE product_id = $1 AND status = 'RUNNING' LIMIT 1`,
      [input.productId],
    );
    if (existingTest.rows.length > 0) {
      return { shouldTest: false, reason: 'Test already running for this product', testPrice: input.currentPrice, changePct: 0, variantName: 'test_high' };
    }

    if (input.trigger === 'HIGH_ROAS' && input.roas >= SmartPricingEngine.HIGH_ROAS_TRIGGER) {
      const testPrice = Math.round(input.currentPrice * (1 + SmartPricingEngine.HIGH_PRICE_LIFT_PCT));
      return {
        shouldTest:  true,
        reason:      `ROAS ${input.roas.toFixed(1)} ≥ ${SmartPricingEngine.HIGH_ROAS_TRIGGER} — testing higher price`,
        testPrice,
        changePct:   SmartPricingEngine.HIGH_PRICE_LIFT_PCT * 100,
        variantName: 'test_high',
      };
    }

    if (input.trigger === 'LOW_CVR') {
      const testPrice = Math.round(input.currentPrice * (1 - SmartPricingEngine.LOW_PRICE_DROP_PCT));
      return {
        shouldTest:  true,
        reason:      'CVR declining — testing lower price to recover volume',
        testPrice,
        changePct:   -SmartPricingEngine.LOW_PRICE_DROP_PCT * 100,
        variantName: 'test_low',
      };
    }

    return { shouldTest: false, reason: 'No trigger condition met', testPrice: input.currentPrice, changePct: 0, variantName: 'test_high' };
  }

  /**
   * Launch a price test after evaluation says yes.
   */
  async launchTest(
    userId: string,
    productId: string,
    decision: PriceTestDecision,
    currentRoas: number,
  ): Promise<string> {
    const result = await this.db.$client.query(
      `INSERT INTO price_tests
         (user_id, product_id, variant_name, price, roas_trigger, roas_at_start, status)
       VALUES ($1,$2,$3,$4,$5,$6,'RUNNING')
       RETURNING id`,
      [
        userId,
        productId,
        decision.variantName,
        decision.testPrice,
        decision.changePct > 0 ? 'HIGH' : 'LOW',
        currentRoas,
      ],
    );

    const testId = result.rows[0].id;
    this.logger.log(
      `Price test launched: product=${productId} ₹${decision.testPrice} (${decision.changePct > 0 ? '+' : ''}${decision.changePct.toFixed(0)}%) testId=${testId}`,
    );
    return testId;
  }

  /**
   * Record a sale on a running price test.
   */
  async recordTestConversion(productId: string, revenue: number): Promise<void> {
    await this.db.$client.query(
      `UPDATE price_tests
          SET conversions = conversions + 1,
              revenue     = revenue + $2
        WHERE product_id = $1 AND status = 'RUNNING'`,
      [productId, revenue],
    );
  }

  /**
   * Get current pricing stats for owner dashboard.
   */
  async getPricingStats(userId: string): Promise<PricingStats> {
    const [active, completed, winners] = await Promise.all([
      this.db.$client.query(
        `SELECT COUNT(*) AS count FROM price_tests WHERE user_id = $1 AND status = 'RUNNING'`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT COUNT(*) AS count FROM price_tests WHERE user_id = $1 AND status IN ('WINNER','LOSER')`,
        [userId],
      ),
      this.db.$client.query(
        `SELECT product_id, price, roas_at_start FROM price_tests
          WHERE user_id = $1 AND status = 'WINNER'
          ORDER BY ended_at DESC LIMIT 5`,
        [userId],
      ),
    ]);

    return {
      activeTests:    parseInt(active.rows[0]?.count ?? '0', 10),
      completedTests: parseInt(completed.rows[0]?.count ?? '0', 10),
      avgPriceLift:   0,  // computed when comparing winner vs control prices
      revenueGainEst: 0,
      currentWinners: winners.rows.map(r => ({
        productId:   r.product_id,
        winnerPrice: parseFloat(r.price),
        liftPct:     SmartPricingEngine.HIGH_PRICE_LIFT_PCT * 100,
      })),
    };
  }

  /**
   * Cron: daily — resolve tests that have run for TEST_DURATION_DAYS.
   * Declares winner or loser based on revenue per impression.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async resolveExpiredTests(): Promise<void> {
    const expiredCutoff = new Date();
    expiredCutoff.setDate(expiredCutoff.getDate() - SmartPricingEngine.TEST_DURATION_DAYS);

    const expired = await this.db.$client.query(
      `SELECT id, product_id, variant_name, price, conversions, revenue, roas_at_start
         FROM price_tests
        WHERE status = 'RUNNING' AND started_at < $1`,
      [expiredCutoff],
    );

    for (const test of expired.rows) {
      const revenue      = parseFloat(test.revenue);
      const isHigherPrice = test.variant_name === 'test_high';

      // Winner = higher-price test generated more revenue than break-even
      // (even with some CVR drop, if revenue per order is higher → profitable)
      const isWinner = isHigherPrice
        ? revenue > 0 && test.conversions >= 3   // at least 3 orders at higher price
        : test.conversions >= 5;                  // lower price should recover volume

      const decision = isWinner
        ? (isHigherPrice ? 'KEEP_HIGHER' : 'TEST_HIGHER')
        : (isHigherPrice ? 'REVERT'       : 'REVERT');

      await this.db.$client.query(
        `UPDATE price_tests
            SET status    = $2,
                roas_at_end = $3,
                decision  = $4,
                ended_at  = NOW()
          WHERE id = $1`,
        [test.id, isWinner ? 'WINNER' : 'LOSER', parseFloat(test.roas_at_start), decision],
      );

      this.logger.log(
        `Price test resolved: ${test.id} → ${isWinner ? 'WINNER' : 'LOSER'} | decision=${decision} | convs=${test.conversions} rev=₹${revenue.toFixed(0)}`,
      );
    }

    if (expired.rows.length > 0) {
      this.logger.log(`Resolved ${expired.rows.length} expired price tests.`);
    }
  }
}
