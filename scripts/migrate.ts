/**
 * migrate.ts — Production Migration Runner (V64)
 * 
 * Usage (development): ts-node scripts/migrate.ts
 * Usage (production):  node dist/scripts/migrate.js
 * 
 * Runs all SQL migrations in numbered order (001_, 002_, ... 010_, ...),
 * tracking applied migrations in schema_migrations to ensure idempotency.
 * Safe to re-run — already-applied migrations are skipped.
 *
 * FIXED: Path resolution works both in ts-node (src root) and compiled JS (dist/).
 */
import * as fs   from 'fs';
import * as path from 'path';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL or DATABASE_URL_DIRECT is not set');
  process.exit(1);
}

async function runMigrations(): Promise<void> {
  const client = new Client({
    connectionString: DATABASE_URL as string,
    ssl:
      (DATABASE_URL as string).includes('supabase') ||
      process.env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    await client.connect();
    console.log('✅  Connected to database');
    console.log(`    Target: ${(DATABASE_URL as string).replace(/:([^:@]+)@/, ':***@')}\n`);

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     VARCHAR(255) PRIMARY KEY,
        applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        checksum    VARCHAR(64)
      );
    `);

    // Resolve migrations directory relative to THIS script, regardless of CWD
    // Works for both: ts-node scripts/migrate.ts  AND  node dist/scripts/migrate.js
    const scriptDir     = __dirname;
    const projectRoot   = path.resolve(scriptDir, '..');
    const migrationsDir = path.join(projectRoot, 'migrations');

    if (!fs.existsSync(migrationsDir)) {
      console.error(`❌  Migrations directory not found: ${migrationsDir}`);
      process.exit(1);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // lexicographic: 001_ < 002_ < ... < 010_ < 011_ ...

    console.log(`📂  Found ${files.length} migration file(s)\n`);

    let applied = 0;
    let skipped = 0;

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [file],
      );

      if (rows.length > 0) {
        console.log(`  ⏭   SKIP  ${file} (already applied)`);
        skipped++;
        continue;
      }

      const sqlPath = path.join(migrationsDir, file);
      const sql     = fs.readFileSync(sqlPath, 'utf8');
      const start   = Date.now();

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`  ✅  APPLY ${file} (${Date.now() - start}ms)`);
        applied++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌  FAIL  ${file}:`, (err as Error).message);
        throw err;
      }
    }

    console.log('\n──────────────────────────────────────────');
    console.log(`✅  Done — applied: ${applied}, skipped: ${skipped}`);
    console.log('──────────────────────────────────────────\n');
  } finally {
    await client.end();
  }
}

runMigrations().catch((err) => {
  console.error('\n❌  Migration failed:', err.message);
  process.exit(1);
});
