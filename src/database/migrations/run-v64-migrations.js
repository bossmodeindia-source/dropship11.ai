#!/usr/bin/env node
/**
 * V64 Migration Runner
 *
 * Runs all V64 database migrations in correct dependency order:
 *   1. add_wallet_tables.sql      — wallet_balances, wallet_transactions
 *   2. add_return_shield_tables.sql — return_requests, return_evidence,
 *                                     return_status_history, return_audit_logs
 *
 * Usage:
 *   DATABASE_URL=postgres://... node src/database/migrations/run-v64-migrations.js
 *
 * OR via npm:
 *   npm run migrate:v64
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

  const migrations = [
    'add_wallet_tables.sql',
    'add_return_shield_tables.sql',
  ];

  const client = await pool.connect();

  try {
    console.log('🚀 Starting V64 migrations...\n');

    for (const fileName of migrations) {
      const filePath = path.join(__dirname, fileName);
      const sql      = fs.readFileSync(filePath, 'utf8');

      console.log(`▶  Running: ${fileName}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`✅ Completed: ${fileName}\n`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ Failed: ${fileName}\n`, err.message);
        throw err;
      }
    }

    console.log('✅ V64 migrations complete.');
    console.log('\nTables created:');
    console.log('  ✅ wallet_balances');
    console.log('  ✅ wallet_transactions');
    console.log('  ✅ return_requests');
    console.log('  ✅ return_evidence');
    console.log('  ✅ return_status_history');
    console.log('  ✅ return_audit_logs');
    console.log('\nEnums created:');
    console.log('  ✅ wallet_tx_type, wallet_tx_status');
    console.log('  ✅ return_status, return_risk_level, return_admin_action');

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
