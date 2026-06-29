// V49 schema additions — import in database index.ts
// Append this table to src/common/database/index.ts exports

import {
  pgTable, uuid, numeric, timestamp,
} from 'drizzle-orm/pg-core';
import { products } from '../../common/database/schema';

export const predictiveMetrics = pgTable('predictive_metrics', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  productId:           uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  predictedRoas:       numeric('predicted_roas',       { precision: 10, scale: 4 }),
  predictedCtr:        numeric('predicted_ctr',        { precision: 7,  scale: 4 }),
  predictedConversion: numeric('predicted_conversion', { precision: 7,  scale: 4 }),
  confidence:          numeric('confidence',           { precision: 5,  scale: 3 }),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
