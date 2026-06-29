#!/usr/bin/env node
/**
 * run-v67-migrations.js
 *
 * Runs the V67 Enterprise Certification migration:
 *   - Pipeline tables (formerly TypeORM entities) formalized in Postgres
 *   - TypeORM metadata cleanup
 *   - Financial audit trigger extended to pipeline_runs
 *
 * Safe to run multiple times (all DDL is idempotent).
 *
 * Usage:
 *   node src/database/migrations/run-v67-migrations.js
 *   npm run migrate:v67
 *   npm run migrate:all   ← runs v66 + v67 in sequence
 */
'use strict';

const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const client = await pool.connect();
  try {
    console.log('🔵 V67 Migration: pipeline table formalization + TypeORM removal cleanup...');
    const sql = fs.readFileSync(
      path.join(__dirname, 'v67-typeorm-removal.sql'),
      'utf8',
    );
    await client.query(sql);
    console.log('✅ V67 Migration: completed successfully');
    console.log('   ✓ creatives table created / verified');
    console.log('   ✓ creative_performance table created / verified (FK → creatives)');
    console.log('   ✓ learning_data table created / verified');
    console.log('   ✓ bandit_sessions table created / verified');
    console.log('   ✓ pipeline_runs table created / verified');
    console.log('   ✓ Financial audit trigger extended to pipeline_runs');
    console.log('   ✓ TypeORM metadata tables dropped (if existed)');
    console.log('   ✓ v67-typeorm-removal recorded in schema_migrations');
  } catch (err) {
    console.error('❌ V67 Migration FAILED:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
