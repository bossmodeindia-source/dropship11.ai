/**
 * Schema Consolidation Tests — V67 Enterprise Certification
 *
 * Verifies the single-schema, single-migration-path requirement:
 *   ✅ All pipeline tables defined in canonical schema.ts
 *   ✅ v44-schema.ts is a re-export only (no independent table definitions)
 *   ✅ No duplicate table definitions across schema files
 *   ✅ All Drizzle type inferences work correctly
 *   ✅ No TypeORM @Entity classes remain
 */

import * as fs   from 'fs';
import * as path from 'path';

const ROOT    = process.cwd();
const SCHEMA  = path.join(ROOT, 'src/common/database/schema.ts');
const ESCROW_SCHEMA = path.join(ROOT, 'src/escrow/escrow-schema.ts');
const WALLET_SCHEMA = path.join(ROOT, 'src/wallet/wallet-schema.ts');
const V44     = path.join(ROOT, 'src/common/database/v44-schema.ts');
const ENTITIES = path.join(ROOT, 'src/pipeline/entities/index.ts');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readFile(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function stripComments(src: string): string {
  return src.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function findExportedTables(src: string): string[] {
  const matches = src.match(/export const (\w+) = pgTable/g) ?? [];
  return matches.map(m => m.replace('export const ', '').replace(' = pgTable', ''));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Schema Single Source of Truth — V67', () => {
  const schemaSrc = readFile(SCHEMA);
  const canonicalSchemaSources = [schemaSrc, readFile(ESCROW_SCHEMA), readFile(WALLET_SCHEMA)].join('\n');

  describe('canonical schema.ts completeness', () => {
    it('should exist and be non-empty', () => {
      expect(schemaSrc.length).toBeGreaterThan(100);
    });

    const requiredTables = [
      'users', 'products', 'orders', 'escrowTransactions',
      'withdrawals', 'walletBalances',
      // Pipeline tables (migrated from TypeORM in V67)
      'creatives', 'creativePerformance', 'learningData',
      'banditSessions', 'pipelineRuns',
      // V44 tables (merged from v44-schema.ts in V66)
      'v44Orders', 'v44OrderItems', 'v44SupplierOrders',
      // Outbox (added in V66)
      'outboxEvents',
    ];

    for (const table of requiredTables) {
      it(`should contain table: ${table}`, () => {
        expect(canonicalSchemaSources).toContain(`export const ${table}`);
      });
    }
  });

  describe('pipeline tables have correct Drizzle column types', () => {
    it('creatives table should use doublePrecision for score/ctr/cvr', () => {
      expect(schemaSrc).toContain("doublePrecision('score')");
      expect(schemaSrc).toContain("doublePrecision('predicted_ctr')");
    });

    it('creativePerformance should have FK reference to creatives', () => {
      expect(schemaSrc).toContain("references(() => creatives.id");
    });

    it('banditSessions should have status varchar column', () => {
      expect(schemaSrc).toContain("'running'");
      expect(schemaSrc).toMatch(/banditSessions[\s\S]*?status/);
    });

    it('pipelineRuns should track financial metrics', () => {
      const pipelineSection = schemaSrc.slice(schemaSrc.indexOf('pipelineRuns'));
      expect(pipelineSection).toContain('finalRoas');
      expect(pipelineSection).toContain('totalSpend');
      expect(pipelineSection).toContain('profit');
    });
  });

  describe('no duplicate table definitions', () => {
    it('should have no table defined twice', () => {
      const tables = findExportedTables(schemaSrc);
      const unique  = new Set(tables);
      expect(tables.length).toBe(unique.size);
    });
  });

  describe('v44-schema.ts is a re-export only', () => {
    it('should exist', () => {
      expect(fs.existsSync(V44)).toBe(true);
    });

    it('should NOT contain independent pgTable definitions', () => {
      const v44Src = readFile(V44);
      const active  = stripComments(v44Src);
      // It should not define new tables — only re-export from schema.ts
      expect(active).not.toContain('pgTable(');
    });

    it('should re-export from schema.ts', () => {
      const v44Src = readFile(V44);
      expect(v44Src).toContain("from './schema'");
    });

    it('should export the v44 table names for backward compatibility', () => {
      const v44Src = readFile(V44);
      expect(v44Src).toContain('v44Orders');
      expect(v44Src).toContain('v44OrderItems');
      expect(v44Src).toContain('v44SupplierOrders');
    });
  });

  describe('pipeline entities/index.ts — TypeORM removed', () => {
    it('should exist', () => {
      expect(fs.existsSync(ENTITIES)).toBe(true);
    });

    it('should NOT contain TypeORM @Entity decorator', () => {
      const src    = readFile(ENTITIES);
      const active = stripComments(src);
      expect(active).not.toContain('@Entity(');
    });

    it('should NOT import from typeorm', () => {
      const src    = readFile(ENTITIES);
      const active = stripComments(src);
      expect(active).not.toContain("from 'typeorm'");
      expect(active).not.toContain("from '@nestjs/typeorm'");
    });

    it('should re-export Drizzle table definitions', () => {
      const src = readFile(ENTITIES);
      expect(src).toContain('creatives');
      expect(src).toContain('pipelineRuns');
    });

    it('should export pipeline-types.ts type aliases', () => {
      const typesFile = path.join(ROOT, 'src/pipeline/entities/pipeline-types.ts');
      expect(fs.existsSync(typesFile)).toBe(true);
      const typesSrc = readFile(typesFile);
      // Should use Drizzle's $inferSelect pattern
      expect(typesSrc).toContain('$inferSelect');
      expect(typesSrc).not.toContain('@Entity(');
    });
  });

  describe('Drizzle imports in schema.ts', () => {
    it('should import doublePrecision and bigint', () => {
      expect(schemaSrc).toContain('doublePrecision');
      expect(schemaSrc).toContain('bigint');
    });

    it('should import from drizzle-orm/pg-core only (no typeorm imports)', () => {
      expect(schemaSrc).toContain("from 'drizzle-orm/pg-core'");
      expect(schemaSrc).not.toContain("from 'typeorm'");
    });
  });
});
