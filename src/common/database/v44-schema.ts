/**
 * v44-schema.ts — V66 COMPATIBILITY RE-EXPORT
 *
 * V66 Medium Fix #4: All v44 schema definitions have been merged into
 * the canonical schema.ts (single source of truth).
 *
 * This file now re-exports from schema.ts to maintain backward compatibility
 * for any legacy code still importing from 'v44-schema'.
 *
 * ACTION: Migrate all imports to: import { ... } from './schema';
 * This file will be removed in V67.
 */

export {
  v44Orders,
  v44OrderItems,
  v44SupplierOrders,
  v44OrderLogs,
} from './schema';
