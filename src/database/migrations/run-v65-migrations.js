#!/usr/bin/env node
/**
 * V65 Migration Runner
 *
 * Runs migration 013 which adds:
 *   1. CRITICAL unique constraint: escrow_transactions(razorpay_payment_id)
 *      — prevents duplicate escrow on Razorpay webhook retry (P0 financial fix)
 *   2. outbox_events table — required for OutboxService
 *   3. 17 performance indexes (CONCURRENTLY — non-blocking)
 *   4. Partial unique index on commission_config(is_enabled)
 *
 * IMPORTANT: If duplicate razorpay_payment_id rows exist (pre-migration), 
 * run this dedup query FIRST before applying the migration:
 *
 *   DELETE FROM escrow_transactions a USING escrow_transactions b
 *   WHERE a.id < b.id AND a.razorpay_payment_id = b.razorpay_payment_id;
 *
 * Usage:
 *   DATABASE_URL=postgres://... node src/database/migrations/run-v65-migrations.js
 *
 * OR via npm:
 *   npm run migrate:v65
 */

const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  });

  const migrationFile = path.join(
    __dirname,
    '../../../migrations/013_v65_performance_indexes.sql',
  );

  console.log('[V65] Running migration 013_v65_performance_indexes.sql...');
  const sql = fs.readFileSync(migrationFile, 'utf8');

  try {
    await pool.query(sql);
    console.log('[V65] ✅ Migration 013 complete.');

    // Verify critical constraint
    const { rows } = await pool.query(`
      SELECT conname, contype FROM pg_constraint
      WHERE conrelid = 'escrow_transactions'::regclass
        AND conname = 'uq_escrow_razorpay_payment_id'
    `);
    if (rows.length > 0 && rows[0].contype === 'u') {
      console.log('[V65] ✅ Unique constraint uq_escrow_razorpay_payment_id VERIFIED.');
    } else {
      console.error('[V65] ❌ CRITICAL: Unique constraint NOT FOUND after migration!');
      process.exit(1);
    }

    // Verify outbox table
    const { rows: outboxRows } = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'outbox_events'
    `);
    if (outboxRows.length > 0) {
      console.log('[V65] ✅ outbox_events table VERIFIED.');
    } else {
      console.error('[V65] ❌ outbox_events table NOT FOUND!');
      process.exit(1);
    }

    console.log('[V65] All V65 migration checks passed. System ready.');
  } catch (err) {
    console.error('[V65] Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
