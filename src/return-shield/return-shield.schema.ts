/**
 * return-shield.schema.ts — V70 Production Certified
 *
 * Tables:
 *   return_requests        — master return record (admin-gated)
 *   return_evidence        — evidence metadata (files stored in Telegram CDN)
 *   return_status_history  — immutable status transition log
 *   return_audit_logs      — immutable admin action audit trail
 *
 * REQUIREMENT 6: Complete return lifecycle states including pickup,
 * in-transit, received, and refund states per spec.
 *
 * INVARIANT: A return_request NEVER auto-transitions beyond RETURN_REQUESTED.
 *            Only admin can advance status. Financial state is NEVER touched
 *            by the return pipeline unless admin explicitly triggers it.
 *
 * If returns are disabled for a tenant, the Return button must be
 * completely removed from the Shopify storefront via theme injection.
 * Never show a fake processing state.
 */

import {
  pgTable, uuid, varchar, text, numeric,
  timestamp, boolean, integer, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { users }  from '../common/database/schema';

// ── Return Status Enum — V70: Full lifecycle per spec ──────────────────────
// REQUIREMENT 6:
//   RETURN_REQUESTED → RETURN_APPROVED | RETURN_REJECTED
//   RETURN_APPROVED  → RETURN_PICKUP_SCHEDULED
//   RETURN_PICKUP_SCHEDULED → RETURN_IN_TRANSIT
//   RETURN_IN_TRANSIT → RETURN_RECEIVED
//   RETURN_RECEIVED   → REFUND_PENDING
//   REFUND_PENDING    → REFUND_COMPLETED
//
// Legacy admin-review states preserved for backward compatibility.
export const returnStatusEnum = pgEnum('return_status', [
  // ── V70 required lifecycle (spec-compliant) ─────────────────────────────
  'RETURN_REQUESTED',           // Customer submitted; waiting admin review
  'RETURN_APPROVED',            // Admin approved the return
  'RETURN_REJECTED',            // Admin rejected the return (terminal)
  'RETURN_PICKUP_SCHEDULED',    // Logistics pickup scheduled
  'RETURN_IN_TRANSIT',          // Item picked up and in transit to warehouse
  'RETURN_RECEIVED',            // Item received at warehouse; pending inspection
  'REFUND_PENDING',             // Refund authorised; awaiting gateway processing
  'REFUND_COMPLETED',           // Refund successfully issued (terminal)
  // ── Legacy admin-review states (backward compatible) ───────────────────
  'RETURN_PROCESSING',          // Legacy: admin review queue
  'UNDER_ADMIN_REVIEW',         // Legacy: escalated review
  'WAITING_INTERNAL_APPROVAL',  // Legacy: multi-step approval
  'APPROVED_MANUALLY',          // Legacy: maps to RETURN_APPROVED
  'REFUND_MANUALLY_PROCESSED',  // Legacy: maps to REFUND_COMPLETED
  'CLOSED',                     // Terminal: no financial action
]);

// ── Return Risk Flag ────────────────────────────────────────────────────────
export const returnRiskEnum = pgEnum('return_risk_level', [
  'LOW',
  'MEDIUM',
  'HIGH_RISK_RETURN',
]);

// ── Admin Action Types ──────────────────────────────────────────────────────
export const returnAdminActionEnum = pgEnum('return_admin_action', [
  'STATUS_CHANGED',
  'APPROVED',
  'REJECTED',
  'MORE_INFO_REQUESTED',
  'FROZEN',
  'CLOSED',
  'REFUND_TRIGGERED',
  'NOTE_ADDED',
  'RISK_FLAGGED',
  'AUDIT_EXPORTED',
]);

// ── return_requests ─────────────────────────────────────────────────────────
export const returnRequests = pgTable('return_requests', {
  id:            uuid('id').primaryKey().defaultRandom(),
  tenantId:      varchar('tenant_id',    { length: 36 }).notNull(),
  orderId:       uuid('order_id').notNull(),
  customerId:    uuid('customer_id').notNull().references(() => users.id),
  productId:     varchar('product_id',   { length: 100 }),

  // Customer submission
  reason:        text('reason').notNull(),
  notes:         text('notes'),
  shopifyReturnId: varchar('shopify_return_id', { length: 100 }), // if triggered via Shopify webhook

  // Status — always starts at RETURN_PROCESSING, NEVER auto-advances
  status:        returnStatusEnum('status').notNull().default('RETURN_PROCESSING'),

  // Admin fields
  adminNotes:    text('admin_notes'),
  adminActorId:  uuid('admin_actor_id').references(() => users.id),
  rejectionReason: text('rejection_reason'),

  // Financial exposure (computed at review time, NEVER acted on automatically)
  estimatedRefundExposure: numeric('estimated_refund_exposure', { precision: 14, scale: 2 }),
  currency:                varchar('currency', { length: 3 }).notNull().default('INR'),

  // Fraud detection
  riskLevel:     returnRiskEnum('risk_level').notNull().default('LOW'),
  riskScore:     integer('risk_score').notNull().default(0),
  riskFlags:     jsonb('risk_flags').notNull().default('[]'),

  // Fulfillment context snapshot (admin reference — never auto-acted on)
  fulfillmentStatus:  varchar('fulfillment_status', { length: 50 }),
  paymentStatus:      varchar('payment_status',     { length: 50 }),
  supplierStatus:     varchar('supplier_status',    { length: 50 }),
  userProfitSnapshot: numeric('user_profit_snapshot', { precision: 14, scale: 2 }),

  // Shopify override flags
  shopifyReturnBlocked:  boolean('shopify_return_blocked').notNull().default(true),
  shopifyRefundBlocked:  boolean('shopify_refund_blocked').notNull().default(true),

  // Timestamps
  adminReviewedAt:    timestamp('admin_reviewed_at',    { withTimezone: true }),
  refundProcessedAt:  timestamp('refund_processed_at',  { withTimezone: true }),
  closedAt:           timestamp('closed_at',            { withTimezone: true }),
  createdAt:          timestamp('created_at',           { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp('updated_at',           { withTimezone: true }).notNull().defaultNow(),
});

// ── return_evidence ─────────────────────────────────────────────────────────
// Evidence metadata ONLY. Actual files stored in Telegram CDN.
// Customers NEVER see telegramFileId or channelId.
export const returnEvidence = pgTable('return_evidence', {
  id:              uuid('id').primaryKey().defaultRandom(),
  returnRequestId: uuid('return_request_id').notNull()
    .references(() => returnRequests.id, { onDelete: 'cascade' }),
  tenantId:        varchar('tenant_id', { length: 36 }).notNull(),
  uploadedBy:      uuid('uploaded_by').notNull().references(() => users.id),

  // File metadata (safe for DB — no sensitive internal IDs)
  fileName:        varchar('file_name', { length: 255 }).notNull(),
  mimeType:        varchar('mime_type', { length: 100 }).notNull(),
  fileSize:        integer('file_size').notNull(),
  fileType:        varchar('file_type', { length: 20 }).notNull(), // 'image' | 'video' | 'document'

  // Telegram CDN internal references — NEVER exposed to customers
  telegramFileId:  text('telegram_file_id'),       // encrypted
  telegramMsgId:   varchar('telegram_msg_id', { length: 50 }),
  telegramChannel: varchar('telegram_channel', { length: 50 }),  // admin-only channel

  // Admin-only URL (presigned or admin-dashboard only)
  internalUrl:     text('internal_url'),

  isAdminOnly:     boolean('is_admin_only').notNull().default(false),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── return_status_history ───────────────────────────────────────────────────
// Immutable. Never updated or deleted.
export const returnStatusHistory = pgTable('return_status_history', {
  id:              uuid('id').primaryKey().defaultRandom(),
  returnRequestId: uuid('return_request_id').notNull()
    .references(() => returnRequests.id, { onDelete: 'cascade' }),
  tenantId:        varchar('tenant_id', { length: 36 }).notNull(),

  fromStatus:      varchar('from_status', { length: 50 }),
  toStatus:        varchar('to_status',   { length: 50 }).notNull(),
  actorId:         uuid('actor_id').references(() => users.id),
  actorType:       varchar('actor_type', { length: 20 }).notNull().default('system'), // 'system' | 'admin' | 'superadmin'
  reason:          text('reason'),
  metadata:        jsonb('metadata').notNull().default('{}'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── return_audit_logs ───────────────────────────────────────────────────────
// Immutable enterprise audit trail for all return-related actions.
export const returnAuditLogs = pgTable('return_audit_logs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  returnRequestId: uuid('return_request_id')
    .references(() => returnRequests.id, { onDelete: 'set null' }),
  tenantId:        varchar('tenant_id', { length: 36 }).notNull(),
  actorId:         uuid('actor_id').references(() => users.id),
  actorRole:       varchar('actor_role',   { length: 30 }),

  action:          returnAdminActionEnum('action').notNull(),
  description:     text('description').notNull(),
  previousValue:   jsonb('previous_value'),
  newValue:        jsonb('new_value'),

  // Financial safety guard — what was NOT done
  autoRefundPrevented:     boolean('auto_refund_prevented').notNull().default(false),
  autoSupplierPrevented:   boolean('auto_supplier_prevented').notNull().default(false),
  autoInventoryPrevented:  boolean('auto_inventory_prevented').notNull().default(false),

  ipAddress:       varchar('ip_address', { length: 45 }),
  userAgent:       text('user_agent'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
