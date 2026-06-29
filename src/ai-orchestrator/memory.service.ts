/**
 * MemoryService
 *
 * The self-learning layer of the AI orchestration engine.
 *
 * Responsibilities:
 *  1. Retrieve top-N winning creative patterns from ai_memory table
 *  2. Inject those patterns into system prompts before NVIDIA calls
 *  3. Store new winning patterns (called by FeedbackProcessor)
 *  4. Prune stale / low-performing patterns
 *
 * Memory is cross-user: a winning pattern for "Electronics" from User A
 * benefits all subsequent Electronics queries, regardless of user.
 *
 * On DB failure: returns empty patterns array — execution continues without enrichment.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, gte, desc, lt, sql, notInArray } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export interface MemoryPattern {
  hook:             string | null;
  headline:         string | null;
  caption:          string | null;
  ctr:              number;
  roas:             number;
  performanceScore: number;
}

export interface StoreMemoryInput {
  operation:      string;
  category:       string;
  hook?:          string;
  headline?:      string;
  caption?:       string;
  ctr:            number;
  roas:           number;
  sourceCampaign?: string;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // ── Retrieval ──────────────────────────────────────────────────────────────

  async getTopPatterns(
    operation: string,
    context:   Record<string, unknown>,
    limit      = 3,
  ): Promise<MemoryPattern[]> {
    const category = ((context['category'] as string) ?? 'general').toLowerCase();

    try {
      const rows = await this.db.query.aiMemory.findMany({
        where: and(
          eq(schema.aiMemory.operation, operation),
          sql`(${schema.aiMemory.category} = ${category} OR ${schema.aiMemory.category} = 'general')`,
        ),
        orderBy: [desc(schema.aiMemory.performanceScore)],
        limit,
      });

      return rows.map(r => ({
        hook:             r.hook             ?? null,
        headline:         r.headline         ?? null,
        caption:          r.caption          ?? null,
        ctr:              parseFloat(r.ctr   ?? '0'),
        roas:             parseFloat(r.roas  ?? '0'),
        performanceScore: parseFloat(r.performanceScore),
      }));
    } catch (err) {
      this.logger.warn(`[Memory] Failed to load patterns: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Prompt enrichment ──────────────────────────────────────────────────────

  buildMemoryEnrichedPrompt(basePrompt: string, patterns: MemoryPattern[]): string {
    if (patterns.length === 0) return basePrompt;

    const patternBlock = patterns
      .map((p, i) =>
        `Pattern ${i + 1} (score ${p.performanceScore.toFixed(2)}, ` +
        `CTR ${p.ctr.toFixed(2)}%, ROAS ${p.roas.toFixed(2)}x):\n` +
        `  Hook:     ${p.hook     ?? 'N/A'}\n` +
        `  Headline: ${p.headline ?? 'N/A'}\n` +
        `  Caption:  ${p.caption  ?? 'N/A'}`,
      )
      .join('\n\n');

    return (
      basePrompt +
      `\n\n── WINNING PATTERNS FROM MEMORY (proven in this category) ──\n` +
      `Draw inspiration from these — same emotional triggers, different words:\n\n` +
      patternBlock +
      `\n─────────────────────────────────────────────────────────────\n`
    );
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  async store(input: StoreMemoryInput): Promise<void> {
    const performanceScore = (input.ctr * 0.4) + (input.roas * 0.6);

    try {
      await this.db.insert(schema.aiMemory).values({
        operation:        input.operation,
        category:         input.category.toLowerCase(),
        hook:             input.hook             ?? null,
        headline:         input.headline         ?? null,
        caption:          input.caption          ?? null,
        ctr:              input.ctr.toString(),
        roas:             input.roas.toString(),
        performanceScore: performanceScore.toString(),
        sourceCampaign:   input.sourceCampaign   ?? null,
      });

      this.logger.debug(
        `[Memory] Stored pattern for ${input.operation}/${input.category} ` +
        `(score ${performanceScore.toFixed(2)})`,
      );
    } catch (err) {
      this.logger.warn(`[Memory] Store failed: ${(err as Error).message}`);
    }
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  /**
   * Remove patterns that are both old AND low-performing.
   * Called by FeedbackProcessor.
   */
  async pruneWeak(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000);
      const result = await this.db
        .delete(schema.aiMemory)
        .where(
          and(
            lt(schema.aiMemory.performanceScore, '1.0'),
            lt(schema.aiMemory.createdAt, cutoff),
          ),
        );
      return (result as unknown as { rowCount: number }).rowCount ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Enforce a per-category cap — keep only the top 50 by performance_score.
   */
  async enforceCapPerCategory(category: string, operation: string, cap = 50): Promise<void> {
    try {
      // Get IDs of the top-N to KEEP
      const topRows = await this.db.query.aiMemory.findMany({
        where:   and(
          eq(schema.aiMemory.category, category),
          eq(schema.aiMemory.operation, operation),
        ),
        orderBy: [desc(schema.aiMemory.performanceScore)],
        limit:   cap,
        columns: { id: true },
      });

      if (topRows.length < cap) return; // Nothing to prune

      const keepIds = topRows.map(r => r.id);
      await this.db
        .delete(schema.aiMemory)
        .where(
          and(
            eq(schema.aiMemory.category,  category),
            eq(schema.aiMemory.operation, operation),
            notInArray(schema.aiMemory.id, keepIds),
          ),
        );
    } catch { /* ignore */ }
  }
}
