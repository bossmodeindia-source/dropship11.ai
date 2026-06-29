/**
 * WalletService
 *
 * Thread-safe wallet operations using optimistic locking (version column).
 * Retries up to 3 times on concurrent modification before throwing.
 *
 * Public API:
 *   getBalance(userId)               → current balance
 *   credit(userId, opts)             → add funds (refund / profit credit)
 *   debit(userId, opts)              → subtract funds (withdrawal)
 *   getTransactions(userId, limit)   → recent ledger entries
 */

import {
  Injectable, Logger, Inject,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import { AuditService } from '../audit/audit.service';
import {
  walletBalances,
  walletTransactions,
} from './wallet-schema';

export interface WalletCreditOptions {
  amount:           number;
  type:             'REFUND' | 'PROFIT_CREDIT' | 'BONUS' | 'ADJUSTMENT';
  description:      string;
  orderId?:         string;
  escrowId?:        string;
  razorpayRefundId?: string;
  stripeRefundId?:  string;
  gatewayPaymentId?: string;
  gatewayProvider?: 'razorpay' | 'stripe';
  currency?:        string;
  metadata?:        Record<string, unknown>;
}

export interface WalletDebitOptions {
  amount:      number;
  description: string;
  orderId?:    string;
  metadata?:   Record<string, unknown>;
}

export interface WalletBalance {
  userId:    string;
  balance:   number;
  currency:  string;
  updatedAt: Date;
}

export interface WalletTransaction {
  id:           string;
  type:         string;
  status:       string;
  amount:       number;
  balanceAfter: number;
  currency:     string;
  description:  string;
  orderId:      string | null;
  createdAt:    Date;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly MAX_RETRIES = 3;

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly audit: AuditService,
  ) {}

  // ── Get or create wallet balance ───────────────────────────────────────────

  async getBalance(userId: string): Promise<WalletBalance> {
    const rows = await this.db
      .select()
      .from(walletBalances)
      .where(eq(walletBalances.userId, userId))
      .limit(1);

    if (!rows.length) {
      // Auto-create wallet on first access
      const [row] = await this.db
        .insert(walletBalances)
        .values({ userId, balance: '0.00', currency: 'INR' })
        .onConflictDoNothing()
        .returning();

      if (!row) {
        // Race: another request created it simultaneously — re-fetch
        return this.getBalance(userId);
      }

      return {
        userId,
        balance:   0,
        currency:  'INR',
        updatedAt: row.updatedAt,
      };
    }

    const r = rows[0];
    return {
      userId:    r.userId,
      balance:   +r.balance,
      currency:  r.currency,
      updatedAt: r.updatedAt,
    };
  }

  // ── Credit wallet (refund / profit) ────────────────────────────────────────

  async credit(userId: string, opts: WalletCreditOptions): Promise<WalletTransaction> {
    if (opts.amount <= 0) {
      throw new BadRequestException(`Credit amount must be positive, got: ${opts.amount}`);
    }

    return this.withRetry(userId, async (currentBalance, version) => {
      const newBalance = +(currentBalance + opts.amount).toFixed(2);

      // Update balance with optimistic lock
      const updated = await this.db
        .update(walletBalances)
        .set({
          balance:   String(newBalance),
          version:   version + 1,
          updatedAt: new Date(),
        })
        .where(and(
          eq(walletBalances.userId, userId),
          eq(walletBalances.version, version),
        ))
        .returning({ id: walletBalances.id });

      if (!updated.length) return null; // version mismatch → retry

      // Record transaction
      const [tx] = await this.db
        .insert(walletTransactions)
        .values({
          userId,
          type:             opts.type,
          status:           'COMPLETED',
          amount:           String(opts.amount),
          balanceAfter:     String(newBalance),
          currency:         opts.currency ?? 'INR',
          description:      opts.description,
          orderId:          opts.orderId ?? null,
          escrowId:         opts.escrowId ?? null,
          razorpayRefundId: opts.razorpayRefundId ?? null,
          stripeRefundId:   opts.stripeRefundId ?? null,
          gatewayPaymentId: opts.gatewayPaymentId ?? null,
          gatewayProvider:  opts.gatewayProvider ?? null,
          metadata:         JSON.stringify(opts.metadata ?? {}),
        })
        .returning();

      await this.audit.log({
        action:     'wallet.credit',
        resourceId: tx.id,
        userId,
        metadata:   {
          amount: opts.amount,
          type:   opts.type,
          newBalance,
          orderId: opts.orderId,
        },
      } as any);

      this.logger.log(
        `💰 Wallet credit | userId=${userId} | +₹${opts.amount} | type=${opts.type} | balance=₹${newBalance}`,
      );

      return {
        id:           tx.id,
        type:         tx.type,
        status:       tx.status,
        amount:       +tx.amount,
        balanceAfter: +tx.balanceAfter,
        currency:     tx.currency,
        description:  tx.description,
        orderId:      tx.orderId,
        createdAt:    tx.createdAt,
      };
    });
  }

  // ── Debit wallet (withdrawal) ───────────────────────────────────────────────

  async debit(userId: string, opts: WalletDebitOptions): Promise<WalletTransaction> {
    if (opts.amount <= 0) {
      throw new BadRequestException(`Debit amount must be positive, got: ${opts.amount}`);
    }

    return this.withRetry(userId, async (currentBalance, version) => {
      if (currentBalance < opts.amount) {
        throw new BadRequestException(
          `Insufficient wallet balance. Available: ₹${currentBalance}, Requested: ₹${opts.amount}`,
        );
      }

      const newBalance = +(currentBalance - opts.amount).toFixed(2);

      const updated = await this.db
        .update(walletBalances)
        .set({
          balance:   String(newBalance),
          version:   version + 1,
          updatedAt: new Date(),
        })
        .where(and(
          eq(walletBalances.userId, userId),
          eq(walletBalances.version, version),
        ))
        .returning({ id: walletBalances.id });

      if (!updated.length) return null; // version mismatch → retry

      const [tx] = await this.db
        .insert(walletTransactions)
        .values({
          userId,
          type:         'WITHDRAWAL',
          status:       'COMPLETED',
          amount:       String(-opts.amount),   // negative for debit
          balanceAfter: String(newBalance),
          currency:     'INR',
          description:  opts.description,
          orderId:      opts.orderId ?? null,
          metadata:     JSON.stringify(opts.metadata ?? {}),
        })
        .returning();

      await this.audit.log({
        action:     'wallet.debit',
        resourceId: tx.id,
        userId,
        metadata:   { amount: opts.amount, newBalance },
      } as any);

      this.logger.log(
        `💸 Wallet debit | userId=${userId} | -₹${opts.amount} | balance=₹${newBalance}`,
      );

      return {
        id:           tx.id,
        type:         tx.type,
        status:       tx.status,
        amount:       +tx.amount,
        balanceAfter: +tx.balanceAfter,
        currency:     tx.currency,
        description:  tx.description,
        orderId:      tx.orderId,
        createdAt:    tx.createdAt,
      };
    });
  }

  // ── Transaction history ────────────────────────────────────────────────────

  async getTransactions(userId: string, limit = 50): Promise<WalletTransaction[]> {
    const rows = await this.db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, userId))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(limit);

    return rows.map(r => ({
      id:           r.id,
      type:         r.type,
      status:       r.status,
      amount:       +r.amount,
      balanceAfter: +r.balanceAfter,
      currency:     r.currency,
      description:  r.description,
      orderId:      r.orderId,
      createdAt:    r.createdAt,
    }));
  }

  // ── Optimistic-lock retry loop ─────────────────────────────────────────────

  private async withRetry<T>(
    userId: string,
    fn: (balance: number, version: number) => Promise<T | null>,
  ): Promise<T> {
    // Ensure wallet exists
    await this.getBalance(userId);

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const rows = await this.db
        .select({ balance: walletBalances.balance, version: walletBalances.version })
        .from(walletBalances)
        .where(eq(walletBalances.userId, userId))
        .limit(1);

      if (!rows.length) throw new NotFoundException(`Wallet not found for user ${userId}`);

      const { balance, version } = rows[0];
      const result = await fn(+balance, version);

      if (result !== null) return result;

      this.logger.debug(`Wallet optimistic lock miss (attempt ${attempt}/${this.MAX_RETRIES}) for user ${userId}`);
      // Small back-off before retry
      await new Promise(r => setTimeout(r, attempt * 20));
    }

    throw new Error(`Wallet update failed after ${this.MAX_RETRIES} retries for user ${userId} — high contention`);
  }
}
