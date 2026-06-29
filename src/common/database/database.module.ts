import { Module, Global } from '@nestjs/common';
import { ConfigService }  from '@nestjs/config';
import { Pool }           from 'pg';
import { drizzle }        from 'drizzle-orm/node-postgres';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema        from './schema';
import * as relations     from './schema-relations';
import * as ext           from '../../commerce/schema-extensions';
import * as platformAds   from '../../platform-ads/platform-ads.schema';
import * as telegramStore from '../../telegram-storage/telegram-storage.schema';
// attribution schema merged into schema.ts — V68 (v22 deleted)
import { DatabaseService } from './database.service';

export const DB_TOKEN   = 'DATABASE';
export const POOL_TOKEN = 'PG_POOL';
/** Alias for POOL_TOKEN — used by V59 production modules (vault, health, tenant, etc.) */
export const DB_POOL    = POOL_TOKEN;

/**
 * Canonical full schema — includes all table definitions across the codebase.
 * This is what the Drizzle instance is actually typed with at runtime.
 * Services should inject `DrizzleDB` rather than `NodePgDatabase<typeof schema>`
 * so they can query any table without `as any` casts.
 */
export const fullSchema = {
  ...schema,
  ...relations,
  ...ext,
  ...platformAds,
  ...telegramStore,
  // attribution tables now in canonical schema.ts
};

/** The single canonical Drizzle DB type — use this in all service constructors. */
export type DrizzleDB = NodePgDatabase<typeof fullSchema> & {
  /** Underlying pg.Pool — available at runtime via drizzle's session.$client */
  $client: Pool;
  /** Drizzle raw SQL tag for tagged-template queries */
  sql: typeof import('drizzle-orm').sql;
};

/**
 * DrizzleTx — union of DrizzleDB and any Drizzle transaction handle.
 *
 * Use this type for service methods that can be called either with the
 * top-level DB or with an in-progress transaction (tx from db.transaction()).
 * Drizzle's transaction type is structurally compatible for insert/update/select
 * but lacks $client — this union makes that explicit.
 */
export type DrizzleTx =
  | DrizzleDB
  | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

@Global()
@Module({
  providers: [
    {
      provide: POOL_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connectionString = config.getOrThrow<string>('DATABASE_URL');
        const env = config.get<string>('NODE_ENV', 'development');
        const forceSsl = config.get<string>('DATABASE_SSL') === 'true'
          || connectionString.includes('supabase.co')
          || connectionString.includes('sslmode=require');
        const pool = new Pool({
          connectionString,
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          ...(forceSsl && env !== 'test'
            ? { ssl: { rejectUnauthorized: false } }
            : {}),
        });
        pool.on('error', (err) => console.error('Unexpected PG pool error:', err));
        return pool;
      },
    },
    {
      provide: DB_TOKEN,
      inject: [POOL_TOKEN],
      useFactory: (pool: Pool) => drizzle(pool, { schema: fullSchema }),
    },
    // V30 raw-SQL wrapper — wraps POOL_TOKEN, exported globally
    DatabaseService,
  ],
  exports: [DB_TOKEN, POOL_TOKEN, DatabaseService],
})
export class DatabaseModule {}
