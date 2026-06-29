#!/usr/bin/env node
/**
 * run-v66-migrations.js
 *
 * Runs the V66 Enterprise Certification database hardening migration.
 * Safe to run multiple times (idempotent — all DDL uses IF NOT EXISTS).
 *
 * Usage:
 *   node src/database/migrations/run-v66-migrations.js
 *   npm run migrate:v66
 */
'use strict';

const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

const SQL_PATH = path.join(__dirname, 'v66-enterprise-hardening.sql');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const client = await pool.connect();
  try {
    console.log('🔵 V66 Migration: starting database hardening...');
    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    await client.query(sql);
    console.log('✅ V66 Migration: completed successfully');
    console.log('   ✓ Outbox table created');
    console.log('   ✓ Foreign keys enforced (orders, escrow, supplier_payments, tracking, refunds, profit_distributions)');
    console.log('   ✓ Check constraints added (positive amounts, non-negative balance)');
    console.log('   ✓ Unique constraints added (idempotency)');
    console.log('   ✓ Financial audit triggers applied');
    console.log('   ✓ Wallet version column added (SELECT FOR UPDATE support)');
    console.log('   ✓ Performance indexes created');
  } catch (err) {
    console.error('❌ V66 Migration FAILED:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
