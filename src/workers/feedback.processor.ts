/**
 * FeedbackProcessor
 *
 * The self-learning feedback loop — runs every 60 minutes via BullMQ repeatable job.
 *
 * Algorithm:
 *  1. Query campaigns with fresh metrics (updated in the last 70 min, ≥100 impressions)
 *  2. Filter winners: CTR ≥ 2.5% OR ROAS ≥ 3.0
 *  3. Compute performance_score = CTR×0.4 + ROAS×0.6
 *  4. Store winning creative patterns in ai_memory
 *  5. Prune weak / stale patterns (score < 1.0, age > 14 days)
 *  6. Enforce per-category cap (top 50 per operation+category)
 *  7. Invalidate stale cache keys for affected categories
 *
 * Effect: Next NVIDIA 49B call for the same category receives memory-enriched
 *         prompts with the top 3 proven patterns → measurably higher CTR.
 */

import { Processor, WorkerHost } from "@nestjs/bullmq";;
import { Logger, Inject } from '@nestjs/common';
import { Job } from "bullmq";;
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, gte, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { MemoryService } from '../ai-orchestrator/memory.service';
import { AI_BACKGROUND_QUEUE, JOB_MEMORY_HARVEST } from './queue.constants';

const MIN_CTR_FOR_MEMORY  = 2.5;  // %
const MIN_ROAS_FOR_MEMORY = 3.0;
const MIN_IMPRESSIONS     = 100;

interface CampaignMetricRow {
  id:        string;
  adCopy:    Record<string, string> | null;
  category:  string | null;
  ctr:       string | null;
  roas:      string | null;
  impressions: string | null;
}

@Processor(AI_BACKGROUND_QUEUE)
export class FeedbackProcessor {
  private readonly logger = new Logger(FeedbackProcessor.name);

  constructor(
    @Inject(DB_TOKEN)  private readonly db:     NodePgDatabase<typeof schema>,
    private readonly memory: MemoryService,
  ) {}

  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async harvestFeedback(_job: Job): Promise<void> {
    this.logger.log('[Feedback] Starting campaign metrics harvest...');

    const campaigns = await this.fetchRecentCampaigns();
    this.logger.debug(`[Feedback] Found ${campaigns.length} campaigns to evaluate`);

    let stored  = 0;
    let skipped = 0;
    const affectedCategories = new Set<string>();

    for (const campaign of campaigns) {
      const ctr        = parseFloat(campaign.ctr   ?? '0');
      const roas       = parseFloat(campaign.roas  ?? '0');
      const impressions = parseInt(campaign.impressions ?? '0', 10);

      // Quality gate: minimum impressions for statistical significance
      if (impressions < MIN_IMPRESSIONS) {
        skipped++;
        continue;
      }

      // Only store winners
      if (ctr < MIN_CTR_FOR_MEMORY && roas < MIN_ROAS_FOR_MEMORY) {
        skipped++;
        continue;
      }

      const adCopy   = campaign.adCopy ?? {};
      const category = (campaign.category ?? 'general').toLowerCase();

      await this.memory.store({
        operation:      'campaign',
        category,
        hook:           adCopy['hook']     ?? adCopy['headline'] ?? null,
        headline:       adCopy['headline'] ?? null,
        caption:        adCopy['body']     ?? adCopy['caption']  ?? null,
        ctr,
        roas,
        sourceCampaign: campaign.id,
      });

      affectedCategories.add(category);
      stored++;
    }

    // Prune weak patterns
    const pruned = await this.memory.pruneWeak();

    // Enforce per-category caps
    for (const category of affectedCategories) {
      await this.memory.enforceCapPerCategory(category, 'campaign', 50);
    }

    this.logger.log(
      `[Feedback] Complete — stored: ${stored}, skipped: ${skipped}, pruned: ${pruned}, ` +
      `categories affected: ${affectedCategories.size}`,
    );
  }

  // ── Data fetching ──────────────────────────────────────────────────────────

  private async fetchRecentCampaigns(): Promise<CampaignMetricRow[]> {
    try {
      const seventyMinutesAgo = new Date(Date.now() - 70 * 60 * 1000);

      const rows = await this.db.execute(sql`
        SELECT
          c.id,
          c.ad_copy          AS "adCopy",
          p.category,
          cm.ctr::text,
          cm.roas::text,
          cm.impressions::text
        FROM   campaigns c
        JOIN   campaign_metrics cm ON cm.campaign_id = c.id
        JOIN   products p          ON p.id = c.product_id
        WHERE  cm.updated_at > ${seventyMinutesAgo}
          AND  c.ai_generated = true
          AND  cm.impressions IS NOT NULL
      `);

      return rows.rows as unknown as CampaignMetricRow[];
    } catch (err) {
      this.logger.error(`[Feedback] DB query failed: ${(err as Error).message}`);
      return [];
    }
  }
}
