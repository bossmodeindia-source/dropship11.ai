/**
 * DatabaseService — Thin pg Pool wrapper
 *
 * Provides query/queryOne helper methods used by V30 services
 * (CapitalPoolEngine, NicheIntelligenceService, StoreRegistryService).
 *
 * Uses the shared POOL_TOKEN pool (same connection as Drizzle ORM).
 * Do not create a second pool — always use this wrapper via dependency injection.
 *
 * For new code prefer Drizzle ORM via DB_TOKEN. This service exists for
 * compatibility with V30 services that use raw SQL for append-only event tables.
 */

import { Injectable, Inject } from '@nestjs/common';
import { Pool, PoolClient }   from 'pg';

@Injectable()
export class DatabaseService {
  /** Exposed for rare cases that need the raw pool (e.g. StoreRegistryService.findWeakStores) */
  readonly pool: Pool;

  constructor(@Inject('PG_POOL') pool: Pool) {
    this.pool = pool;
  }

  /**
   * Execute a SQL query and return ALL matching rows.
   * @param sql   Parameterised SQL string (use $1, $2, … placeholders)
   * @param params Query parameters
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql:    string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const { rows } = await this.pool.query<T>(sql, params);
    return rows;
  }

  /**
   * Execute a SQL query and return the FIRST matching row, or null.
   * Useful for SELECT … LIMIT 1, INSERT … RETURNING *, etc.
   */
  async queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
    sql:    string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const { rows } = await this.pool.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Execute multiple statements inside a single transaction.
   * Rolls back automatically on error.
   */
  async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
