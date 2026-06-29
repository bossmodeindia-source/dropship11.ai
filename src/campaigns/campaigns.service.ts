/**
 * CampaignsService (V2 — Updated)
 *
 * Key changes from V1:
 *  1. generate() now enqueues to ai:standard queue and returns { jobId, campaign }
 *     instead of blocking the HTTP thread on an AI call.
 *  2. Media generation similarly enqueued to ai:background (not fire-and-forget inline).
 *  3. AiBotService.dispatch() is still used for the synchronous DB persist path;
 *     AI content generation is offloaded to the worker.
 *  4. StrategyService.evaluate() is now available for campaign analysis — it
 *     delegates to AiOrchestrator (253B in worker, BOT as fallback).
 *
 * The V1 synchronous behaviour is preserved for callers that don't opt in to
 * the async pattern — they receive the BOT-generated campaign immediately while
 * the higher-quality AI version is written back via the job when complete.
 */

import { Injectable, NotFoundException, Inject, Logger } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AiBotService } from '../ai-bot/ai-bot.service';
import { AuditService } from '../audit/audit.service';
import { AiMediaService } from '../ai-media/ai-media.service';
import { AiJobService } from '../workers/ai-job.service';
import { StrategyService, StrategyContext } from './strategy.service';
import { GenerateCampaignDto } from './dto/generate-campaign.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  JOB_CAMPAIGN_GENERATE,
  JOB_MEDIA_GENERATE,
} from '../workers/queue.constants';

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @Inject(DB_TOKEN)          private readonly db:       NodePgDatabase<typeof schema>,
    private readonly aiBot:    AiBotService,
    private readonly audit:    AuditService,
    private readonly aiMedia:  AiMediaService,
    private readonly jobService: AiJobService,
    private readonly strategy:   StrategyService,
  ) {}

  /**
   * POST /campaigns/generate
   *
   * V2 behaviour:
   *  1. BOT generates a synchronous draft campaign immediately (no latency)
   *  2. An ai:standard job is enqueued to enhance it with NVIDIA 49B
   *  3. Media generation is enqueued to ai:background
   *  4. Returns campaign + jobId so client can poll for AI-enhanced version
   */
  async generate(
    user: JwtPayload,
    dto:  GenerateCampaignDto,
  ): Promise<{
    campaign:         typeof schema.campaigns.$inferSelect;
    jobId:            string;
    mediaJobId:       string;
    generatedContent: unknown;
    mode:             string;
    latencyMs:        number;
  }> {
    const product = await this.db.query.products.findFirst({
      where: and(
        eq(schema.products.id,     dto.productId),
        eq(schema.products.userId, user.sub),
      ),
    });
    if (!product) throw new NotFoundException('Product not found');

    const context: Record<string, unknown> = {
      title:          product.title,
      category:       product.category,
      supplierPrice:  product.supplierPrice,
      sellingPrice:   product.sellingPrice,
      decision:       product.decision,
      compositeScore: product.compositeScore,
      tags:           product.tags,
      platform:       dto.platform     ?? 'meta',
      targetAudience: dto.targetAudience,
      budgetDaily:    dto.budgetDaily,
    };

    // ── Step 1: BOT sync draft (zero latency, zero cost) ──────────────────
    const botResult = await this.aiBot.dispatch({
      userId:       user.sub,
      operation:    'campaign',
      context,
      productScore: parseFloat(String(product.compositeScore ?? '0')),
    });

    const generated = botResult.content as {
      hook?:        string;
      headline?:    string;
      body?:        string;
      cta?:         string;
      audience?:    Record<string, unknown>;
      keywords?:    string[];
      dailyBudget?: number;
    };

    // ── Step 2: Persist campaign with BOT draft ───────────────────────────
    const [campaign] = await this.db
      .insert(schema.campaigns)
      .values({
        userId:         user.sub,
        productId:      dto.productId,
        platform:       dto.platform ?? 'meta',
        name:           generated.headline ?? `Campaign for ${product.title}`,
        objective:      dto.objective ?? 'conversions',
        targetAudience: (dto.targetAudience ?? generated.audience ?? {}) as Record<string, unknown>,
        budgetDaily:    dto.budgetDaily
          ? String(dto.budgetDaily)
          : String(generated.dailyBudget ?? 10),
        adCopy: {
          hook:     generated.hook,
          headline: generated.headline,
          body:     generated.body,
          cta:      generated.cta,
        } as Record<string, unknown>,
        keywords:    generated.keywords ?? [],
        aiGenerated: false,       // will be updated to true when AI job completes
        status:      'draft',
      })
      .returning();

    await this.audit.log({
      tenantId: 'system',
      actorId:     user.sub,
      action:     'campaign.generated',
      resource: 'system',


    });

    // ── Step 3: Enqueue AI enhancement job (ai:standard) ─────────────────
    const { jobId } = await this.jobService.createJob({
      userId:    user.sub,
      queue:     'standard',
      jobName:   JOB_CAMPAIGN_GENERATE,
      operation: 'campaign',
      context:   { ...context, campaignId: campaign.id },
    });

    // ── Step 4: Enqueue media generation (ai:background) ─────────────────
    const { jobId: mediaJobId } = await this.jobService.createJob({
      userId:    user.sub,
      queue:     'background',
      jobName:   JOB_MEDIA_GENERATE,
      operation: 'media',
      context: {
        title:       product.title,
        category:    product.category,
        tags:        product.tags,
        description: product.description,
        campaignId:  campaign.id,
      },
    });

    this.logger.log(
      `Campaign ${campaign.id} draft created (BOT). ` +
      `AI job: ${jobId}, Media job: ${mediaJobId}`,
    );

    return {
      campaign,
      jobId,
      mediaJobId,
      generatedContent: botResult.content,
      mode:             botResult.mode,
      latencyMs:        botResult.latencyMs,
    };
  }

  /**
   * POST /campaigns/:id/evaluate
   * Run strategy evaluation via AiOrchestrator (253B if eligible, BOT otherwise).
   */
  async evaluate(
    user:       JwtPayload,
    campaignId: string,
  ): Promise<ReturnType<StrategyService['evaluate']>> {
    const [campaign, metrics] = await Promise.all([
      this.db.query.campaigns.findFirst({
        where: and(
          eq(schema.campaigns.id,     campaignId),
          eq(schema.campaigns.userId, user.sub),
        ),
      }),
      this.db.query.campaignMetrics.findFirst({
        where: (m: typeof schema.campaignMetrics, { eq: eqFn }: { eq: typeof eq }) =>
          eqFn(m.campaignId, campaignId),
      }),
    ]);

    if (!campaign) throw new NotFoundException('Campaign not found');

    const sub = await this.db.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.userId, user.sub),
    });

    const ctx: StrategyContext = {
      campaignId,
      userId:         user.sub,
      productTitle:   campaign.name,
      category:       'general',
      totalSpendUsd:  parseFloat(String((metrics as { spendUsd?: unknown } | null)?.spendUsd ?? '0')),
      roas:           parseFloat(String((metrics as { roas?: unknown } | null)?.roas ?? '0')),
      ctr:            parseFloat(String((metrics as { ctr?: unknown } | null)?.ctr ?? '0')),
      conversions:    (metrics as { conversions?: number } | null)?.conversions ?? 0,
      dailyBudgetUsd: parseFloat(String(campaign.budgetDaily ?? '10')),
      daysRunning:    Math.ceil(
        (Date.now() - new Date(campaign.createdAt).getTime()) / 86_400_000,
      ),
      userTier: (sub?.tier as StrategyContext['userTier']) ?? 'free',
    };

    return this.strategy.evaluate(ctx);
  }

  async findAll(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return {
      items: await this.db.query.campaigns.findMany({
        where:   eq(schema.campaigns.userId, userId),
        orderBy: [desc(schema.campaigns.createdAt)],
        limit,
        offset,
      }),
      page,
      limit,
    };
  }

  async findOne(userId: string, campaignId: string) {
    const campaign = await this.db.query.campaigns.findFirst({
      where: and(
        eq(schema.campaigns.id,     campaignId),
        eq(schema.campaigns.userId, userId),
      ),
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }
}
