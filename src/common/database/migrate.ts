/**
 * Migration runner — applies schema.sql to the target database.
 * Used by: npm run db:push
 *          Docker entrypoint (optional)
 *          CI pipeline before running e2e tests
 *
 * Usage:
 *   DATABASE_URL=postgres://... ts-node src/common/database/migrate.ts
 */
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://dropship:dropship@localhost:5432/dropship';

const SCHEMA_PATH = join(__dirname, '../../../schema.sql');

export async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log('📦 Running migrations...');
    console.log(`   Target: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);

    const sql = readFileSync(SCHEMA_PATH, 'utf-8');
    await pool.query(sql);

    console.log('✅ Migrations complete');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

// Allow running directly
if (require.main === module) {
  runMigrations().catch(() => process.exit(1));
}
