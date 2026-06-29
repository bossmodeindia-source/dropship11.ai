/**
 * WithdrawalFraudService
 *
 * Runs pre-withdrawal safety checks to prevent fraudulent or premature payouts.
 *
 * Rules enforced:
 *   1. PENDING_ORDERS_BLOCK   — User has orders not yet paid to supplier
 *   2. EXCESSIVE_WITHDRAWAL   — Amount > configurable threshold (default ₹50,000/day)
 *   3. FREQUENCY_LIMIT        — Max N withdrawal requests per rolling window
 *   4. DUPLICATE_PENDING      — Already has a pending withdrawal
 *   5. ZERO_REVENUE_GUARD     — Cannot withdraw if platform shows zero revenue
 *   6. SUSPENDED_ACCOUNT      — User account is suspended/frozen
 *
 * On rule violation:
 *   - Returns structured FraudCheckResult (not exception) so the controller
 *     can decide whether to hard-block or flag for review
 *   - Violations are audit-logged with 'critical' severity
 */

import {
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { eq, and, gte, count, sum, sql } from 'drizzle-orm';
import { DrizzleDB, DrizzleTx, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import * as wSchema from './withdrawal-schema';
import { AuditService } from '../audit/audit.service';
import { AlertingService } from '../alerting/alerting.service';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FraudRuleId =
  | 'PENDING_ORDERS_BLOCK'
  | 'EXCESSIVE_WITHDRAWAL'
  | 'FREQUENCY_LIMIT'
  | 'DUPLICATE_PENDING'
  | 'ZERO_REVENUE_GUARD'
  | 'SUSPENDED_ACCOUNT';

export interface FraudCheckResult {
  approved:     boolean;
  violations:   FraudRuleId[];
  pendingOrders: number;
  details:      string[];
}

// Configurable thresholds (could be moved to env/config)
const MAX_DAILY_WITHDRAWAL_INR   = 50_000;   // ₹50,000
const MAX_WITHDRAWALS_PER_7_DAYS = 3;
const MIN_WITHDRAWABLE_REVENUE   = 100;       // ₹100

@Injectable()
export class WithdrawalFraudService {
  private readonly logger = new Logger(WithdrawalFraudService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly audit: AuditService,
    private readonly alerting: AlertingService,
  ) {}

  /**
   * Run all fraud checks for a withdrawal request.
   * Returns approved=false and a list of violations if any rule fires.
   */
  async checkWithdrawal(input: {
    userId:    string;
    tenantId:  string;
    amount:    number;
    ipAddress?: string;
    tx?: DrizzleTx;
  }): Promise<FraudCheckResult> {
    const db = input.tx ?? this.db;
    const violations: FraudRuleId[] = [];
    const details: string[]         = [];

    // ── 1. Suspended account check ───────────────────────────────────────────
    const [user] = await db
      .select({ isActive: schema.users.isActive, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);

    if (!user || !user.isActive) {
      violations.push('SUSPENDED_ACCOUNT');
      details.push('User account is suspended or inactive');
    }

    // ── 2. Pending orders block ───────────────────────────────────────────────
    // Count orders that are pending supplier payment for this tenant
    const pendingOrdersResult = await db.execute<{ cnt: string }>(
      sql`
        SELECT COUNT(*)::text AS cnt
        FROM orders
        WHERE tenant_id = ${input.tenantId}
          AND status IN ('pending_supplier_payment', 'created')
      `,
    );
    const pendingOrders = parseInt(pendingOrdersResult?.rows?.[0]?.cnt ?? '0', 10);

    if (pendingOrders > 0) {
      violations.push('PENDING_ORDERS_BLOCK');
      details.push(
        `${pendingOrders} order(s) are awaiting supplier payment. ` +
        `Resolve all pending orders before requesting withdrawal.`,
      );
    }

    // ── 3. Duplicate pending check ────────────────────────────────────────────
    const [existing] = await db
      .select({ id: wSchema.withdrawals.id })
      .from(wSchema.withdrawals)
      .where(
        and(
          eq(wSchema.withdrawals.userId,   input.userId),
          eq(wSchema.withdrawals.tenantId, input.tenantId),
          eq(wSchema.withdrawals.status,   'pending'),
        ),
      )
      .limit(1);

    if (existing) {
      violations.push('DUPLICATE_PENDING');
      details.push('You already have a pending withdrawal request. Wait for admin review.');
    }

    // ── 4. Frequency limit — max 3 per 7 days ────────────────────────────────
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentCount = await db
      .select({ cnt: count() })
      .from(wSchema.withdrawals)
      .where(
        and(
          eq(wSchema.withdrawals.userId,   input.userId),
          eq(wSchema.withdrawals.tenantId, input.tenantId),
          gte(wSchema.withdrawals.createdAt, sevenDaysAgo),
        ),
      );

    const recentWithdrawals = recentCount?.[0]?.cnt ?? 0;
    if (recentWithdrawals >= MAX_WITHDRAWALS_PER_7_DAYS) {
      violations.push('FREQUENCY_LIMIT');
      details.push(
        `Maximum ${MAX_WITHDRAWALS_PER_7_DAYS} withdrawal requests allowed per 7 days. ` +
        `You have made ${recentWithdrawals} in the last 7 days.`,
      );
    }

    // ── 5. Excessive amount check ─────────────────────────────────────────────
    if (input.amount > MAX_DAILY_WITHDRAWAL_INR) {
      violations.push('EXCESSIVE_WITHDRAWAL');
      details.push(
        `Withdrawal of ₹${input.amount} exceeds the single-request limit of ` +
        `₹${MAX_DAILY_WITHDRAWAL_INR}. Contact support for large withdrawals.`,
      );
    }

    // ── 6. Zero revenue guard ─────────────────────────────────────────────────
    const revenueResult = await db.execute<{ total: string }>(
      sql`
        SELECT COALESCE(SUM(total_price), 0)::text AS total
        FROM orders
        WHERE tenant_id = ${input.tenantId}
          AND status IN ('fulfilled', 'completed', 'supplier_paid')
      `,
    );
    const totalRevenue = parseFloat(revenueResult?.rows?.[0]?.total ?? '0');

    if (totalRevenue < MIN_WITHDRAWABLE_REVENUE) {
      violations.push('ZERO_REVENUE_GUARD');
      details.push(
        `Insufficient confirmed revenue. Minimum ₹${MIN_WITHDRAWABLE_REVENUE} in fulfilled ` +
        `orders required before withdrawal is available.`,
      );
    }

    // ── Alert if violations detected ──────────────────────────────────────────
    if (violations.length > 0) {
      this.logger.warn(
        `[WithdrawalFraud] Violations for user=${input.userId}: ${violations.join(', ')}`,
      );

      // Critical violations trigger immediate admin alert
      const criticalViolations: FraudRuleId[] = ['SUSPENDED_ACCOUNT', 'EXCESSIVE_WITHDRAWAL'];
      if (violations.some(v => criticalViolations.includes(v))) {
        await this.alerting.sendCritical({
          title:   '🚨 Suspicious Withdrawal Detected',
          message: `User ${input.userId} (tenant: ${input.tenantId}) triggered fraud rules: ${violations.join(', ')}. Amount: ₹${input.amount}`,
        });
      }

      await this.audit.log({
        tenantId:   input.tenantId,
        actorId:    input.userId,
        action:     'WITHDRAWAL_FRAUD_BLOCK',
        resource:   'withdrawals',
        severity:   'critical',
        details: {
          violations,
          amount: input.amount,
          pendingOrders,
          ipAddress: input.ipAddress,
        },
      });
    }

    return {
      approved:     violations.length === 0,
      violations,
      pendingOrders,
      details,
    };
  }

  async checkWithdrawalInTx(
    tx: DrizzleTx,
    input: {
      userId: string;
      tenantId: string;
      amount: number;
      currentBalance?: number;
      ipAddress?: string;
    },
  ): Promise<FraudCheckResult> {
    return this.checkWithdrawal({ ...input, tx });
  }

  /**
   * Called by admin to freeze a suspicious account.
   * Freezes all pending withdrawal requests for the user.
   */
  async freezeUserWithdrawals(
    userId: string,
    tenantId: string,
    reason: string,
    adminId: string,
  ): Promise<number> {
    const result = await this.db
      .update(wSchema.withdrawals)
      .set({
        isFrozen:     true,
        frozenReason: reason,
        updatedAt:    new Date(),
      })
      .where(
        and(
          eq(wSchema.withdrawals.userId,   userId),
          eq(wSchema.withdrawals.tenantId, tenantId),
          eq(wSchema.withdrawals.status,   'pending'),
        ),
      )
      .returning({ id: wSchema.withdrawals.id });

    await this.audit.log({
      tenantId,
      actorId:    adminId,
      action:     'WITHDRAWAL_ACCOUNT_FROZEN',
      resource:   'withdrawals',
      resourceId: userId,
      severity:   'critical',
      details:    { reason, frozenCount: result.length },
    });

    await this.alerting.sendCritical({
      title:   '❄️ Withdrawal Account Frozen',
      message: `Admin ${adminId} froze withdrawals for user ${userId}. Reason: ${reason}`,
    });

    return result.length;
  }
}
