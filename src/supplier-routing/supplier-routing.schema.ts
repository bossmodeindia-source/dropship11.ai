/**
 * supplier-routing.schema.ts
 */
import {
  pgTable, uuid, varchar, numeric, integer,
  boolean, jsonb, timestamp, index,
} from 'drizzle-orm/pg-core';

export const supplierRoutingLog = pgTable(
  'supplier_routing_log',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    orderId:       uuid('order_id').notNull(),
    tenantId:      uuid('tenant_id').notNull(),
    selected:      varchar('selected', { length: 64 }).notNull(),
    fallbacks:     jsonb('fallbacks').notNull().default([]),
    score:         numeric('score', { precision: 6, scale: 4 }),
    reasoning:     varchar('reasoning', { length: 512 }),
    landedCost:    numeric('landed_cost', { precision: 10, scale: 2 }),
    estimatedDays: integer('estimated_days'),
    candidateData: jsonb('candidate_data').notNull().default({}),
    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOrder:  index('supplier_routing_order_idx').on(t.orderId),
    idxTenant: index('supplier_routing_tenant_idx').on(t.tenantId),
  }),
);

export const supplierScores = pgTable(
  'supplier_scores',
  {
    id:               uuid('id').primaryKey().defaultRandom(),
    supplier:         varchar('supplier', { length: 64 }).notNull().unique(),
    currentScore:     numeric('current_score', { precision: 6, scale: 2 }).notNull().default('70'),
    totalOrders:      integer('total_orders').notNull().default(0),
    successfulOrders: integer('successful_orders').notNull().default(0),
    createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const supplierRoutingOverrides = pgTable(
  'supplier_routing_overrides',
  {
    id:                uuid('id').primaryKey().defaultRandom(),
    tenantId:          uuid('tenant_id').notNull(),
    preferredSupplier: varchar('preferred_supplier', { length: 64 }).notNull(),
    niche:             varchar('niche', { length: 128 }),
    active:            boolean('active').notNull().default(true),
    createdByAdminId:  uuid('created_by_admin_id').notNull(),
    createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTenant: index('supplier_overrides_tenant_idx').on(t.tenantId),
  }),
);
