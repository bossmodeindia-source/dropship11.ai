/**
 * wallet-schema.ts
 *
 * Tables:
 *   wallet_balances      — one row per user, stores current balance (INR)
 *   wallet_transactions  — append-only ledger of every credit/debit
 *
 * Invariant: wallet_balances.balance = SUM(wallet_transactions.amount) for that user.
 * Credits are positive; debits (withdrawals) are negative.
 */

import {
  pgTable, uuid, varchar, numeric, text,
  timestamp, pgEnum, integer,
} from 'drizzle-orm/pg-core';
import { users } from '../common/database/schema';

// ── Enums ──────────────────────────────────────────────────────────────────

export const walletTxTypeEnum = pgEnum('wallet_tx_type', [
  'REFUND',          // returned product → customer wallet credit
  'PROFIT_CREDIT',   // user profit from a delivered order
  'WITHDRAWAL',      // user withdraws to bank/UPI
  'ADJUSTMENT',      // manual admin adjustment
  'BONUS',           // promotional credit
]);

export const walletTxStatusEnum = pgEnum('wallet_tx_status', [
  'PENDING',
  'COMPLETED',
  'FAILED',
  'REVERSED',
]);

// ── wallet_balances ────────────────────────────────────────────────────────

export const walletBalances = pgTable('wallet_balances', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  balance:   numeric('balance', { precision: 14, scale: 2 }).notNull().default('0.00'),
  currency:  varchar('currency', { length: 3 }).notNull().default('INR'),
  version:   integer('version').notNull().default(0),   // optimistic lock
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── wallet_transactions ────────────────────────────────────────────────────

export const walletTransactions = pgTable('wallet_transactions', {
  id:              uuid('id').primaryKey().defaultRandom(),
  userId:          uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type:            walletTxTypeEnum('type').notNull(),
  status:          walletTxStatusEnum('status').notNull().default('COMPLETED'),
  // Positive = credit, negative = debit
  amount:          numeric('amount', { precision: 14, scale: 2 }).notNull(),
  balanceAfter:    numeric('balance_after', { precision: 14, scale: 2 }).notNull(),
  currency:        varchar('currency', { length: 3 }).notNull().default('INR'),
  // References
  orderId:         uuid('order_id'),               // linked order (if any)
  escrowId:        uuid('escrow_id'),              // linked escrow (if any)
  razorpayRefundId: varchar('razorpay_refund_id', { length: 128 }),
  stripeRefundId:  varchar('stripe_refund_id', { length: 128 }),
  // Human-readable reason for admin/user display
  description:     text('description').notNull(),
  // Original payment gateway info (for audit)
  gatewayPaymentId: varchar('gateway_payment_id', { length: 128 }),
  gatewayProvider:  varchar('gateway_provider', { length: 32 }),  // 'razorpay' | 'stripe'
  metadata:        text('metadata').notNull().default('{}'),      // JSON string
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
