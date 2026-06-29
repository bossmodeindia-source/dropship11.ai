/**
 * platform-ads.processors.ts — V60 PATCH
 *
 * Fix [H6]: 5 BullMQ queues (platform-creative-generation, platform-campaign-launch,
 * platform-retargeting, platform-analytics-sync, platform-alerts) were registered
 * but had zero @Processor / Worker implementations.
 * Jobs queued silently and never executed.
 *
 * This file provides all 5 processors in a single module-friend file.
 * Each processor is exported and registered in PlatformAdsModule.
 *
 * Job payload shapes mirror what PlatformAdsService enqueues.
 * All processors implement OnModuleDestroy to cleanly drain workers on shutdown.
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { PlatformCampaignService }   from '../platform-campaign.service';
import { PlatformCreativeService, PlatformCreativeStyle }   from '../platform-creative.service';
import { PlatformAnalyticsService, MetricsSyncPayload } from '../platform-analytics.service';
import { PlatformRetargetingService } from '../platform-retargeting.service';
import { AlertingService }           from '../../alerting/alerting.service';

// ── Queue names (must match PlatformAdsModule registration) ─────────────────

export const PLATFORM_QUEUE_NAMES = {
  CREATIVE_GENERATION: 'platform-creative-generation',
  CAMPAIGN_LAUNCH:     'platform-campaign-launch',
  RETARGETING:         'platform-retargeting',
  ANALYTICS_SYNC:      'platform-analytics-sync',
  ALERTS:              'platform-alerts',
} as const;

// ── Job payload shapes ────────────────────────────────────────────────────────

export interface CreativeGenerationJobData {
  campaignId: string;
  style:      string;
}

export interface CampaignLaunchJobData {
  campaignId: string;
}

export interface RetargetingJobData {
  segment?: string;  // if undefined → rebuild all segments
}

export interface AnalyticsSyncJobData extends MetricsSyncPayload {}

export interface AlertJobData {
  level:   'info' | 'warn' | 'critical';
  title:   string;
  message: string;
}

// ── Helper: build a deduplicated BullMQ Worker connection ────────────────────

function buildWorkerConnection(redis: Redis): Redis {
  // bullmq requires a dedicated connection — duplicate from shared client
  return redis.duplicate();
}

// ── 1. Creative Generation Processor ─────────────────────────────────────────

@Injectable()
export class PlatformCreativeGenerationProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformCreativeGenerationProcessor.name);
  private worker: Worker<CreativeGenerationJobData>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly creatives: PlatformCreativeService,
  ) {}

  onModuleInit(): void {
    const connection = buildWorkerConnection(this.redis);

    this.worker = new Worker<CreativeGenerationJobData>(
      PLATFORM_QUEUE_NAMES.CREATIVE_GENERATION,
      async (job: Job<CreativeGenerationJobData>) => {
        this.logger.log(
          `[CreativeGen] Processing job ${job.id}: campaign=${job.data.campaignId} style=${job.data.style}`,
        );
        const bundle = await this.creatives.generateBundle(
          job.data.style as PlatformCreativeStyle,
          job.data.campaignId,
        );
        await this.creatives.scoreAndPersist(
          bundle,
          job.data.style as PlatformCreativeStyle,
          job.data.campaignId,
        );
        this.logger.log(`[CreativeGen] Job ${job.id} complete — bundle generated`);
      },
      {
        connection: connection as any,
        concurrency: 3,          // creative gen is AI-heavy — limit concurrency
        limiter: { max: 10, duration: 60_000 },
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `[CreativeGen] Job ${job?.id} failed attempt ${job?.attemptsMade}: ${err.message}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

// ── 2. Campaign Launch Processor ──────────────────────────────────────────────

@Injectable()
export class PlatformCampaignLaunchProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformCampaignLaunchProcessor.name);
  private worker: Worker<CampaignLaunchJobData>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly campaigns: PlatformCampaignService,
  ) {}

  onModuleInit(): void {
    const connection = buildWorkerConnection(this.redis);

    this.worker = new Worker<CampaignLaunchJobData>(
      PLATFORM_QUEUE_NAMES.CAMPAIGN_LAUNCH,
      async (job: Job<CampaignLaunchJobData>) => {
        const { campaignId } = job.data;
        this.logger.log(`[CampaignLaunch] Processing job ${job.id}: campaignId=${campaignId}`);

        try {
          const result = await this.campaigns.launchCampaign(campaignId);
          this.logger.log(
            `[CampaignLaunch] Job ${job.id} complete — meta_campaign_id=${result.metaCampaignId}`,
          );
        } catch (err) {
          // Non-retryable if already active
          if ((err as Error).message?.includes('already active')) {
            throw new UnrecoverableError(`Campaign ${campaignId} already active — skipping retry`);
          }
          throw err;
        }
      },
      {
        connection: connection as any,
        concurrency: 5,
        limiter: { max: 20, duration: 60_000 },
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `[CampaignLaunch] Job ${job?.id} failed attempt ${job?.attemptsMade}: ${err.message}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

// ── 3. Retargeting Processor ──────────────────────────────────────────────────

@Injectable()
export class PlatformRetargetingProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformRetargetingProcessor.name);
  private worker: Worker<RetargetingJobData>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly retargeting: PlatformRetargetingService,
  ) {}

  onModuleInit(): void {
    const connection = buildWorkerConnection(this.redis);

    this.worker = new Worker<RetargetingJobData>(
      PLATFORM_QUEUE_NAMES.RETARGETING,
      async (job: Job<RetargetingJobData>) => {
        this.logger.log(
          `[Retargeting] Processing job ${job.id}: segment=${job.data.segment ?? 'ALL'}`,
        );
        await this.retargeting.launchRetargetingCampaigns();
        this.logger.log(`[Retargeting] Job ${job.id} complete`);
      },
      {
        connection: connection as any,
        concurrency: 1,   // retargeting touches many DB rows; serialize to avoid races
        limiter: { max: 2, duration: 60_000 },
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `[Retargeting] Job ${job?.id} failed attempt ${job?.attemptsMade}: ${err.message}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

// ── 4. Analytics Sync Processor ───────────────────────────────────────────────

@Injectable()
export class PlatformAnalyticsSyncProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformAnalyticsSyncProcessor.name);
  private worker: Worker<AnalyticsSyncJobData>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly analytics: PlatformAnalyticsService,
  ) {}

  onModuleInit(): void {
    const connection = buildWorkerConnection(this.redis);

    this.worker = new Worker<AnalyticsSyncJobData>(
      PLATFORM_QUEUE_NAMES.ANALYTICS_SYNC,
      async (job: Job<AnalyticsSyncJobData>) => {
        this.logger.debug(
          `[AnalyticsSync] Processing job ${job.id}: campaign=${job.data.campaignId}`,
        );
        await this.analytics.syncMetrics(job.data);
        this.logger.debug(`[AnalyticsSync] Job ${job.id} complete`);
      },
      {
        connection: connection as any,
        concurrency: 20,  // metric ingestion is fast + idempotent; high concurrency OK
        limiter: { max: 200, duration: 60_000 },
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `[AnalyticsSync] Job ${job?.id} failed attempt ${job?.attemptsMade}: ${err.message}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

// ── 5. Alerts Processor ───────────────────────────────────────────────────────

@Injectable()
export class PlatformAlertsProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformAlertsProcessor.name);
  private worker: Worker<AlertJobData>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly alerting: AlertingService,
  ) {}

  onModuleInit(): void {
    const connection = buildWorkerConnection(this.redis);

    this.worker = new Worker<AlertJobData>(
      PLATFORM_QUEUE_NAMES.ALERTS,
      async (job: Job<AlertJobData>) => {
        this.logger.debug(`[Alerts] Processing job ${job.id}: level=${job.data.level}`);
        switch (job.data.level) {
          case 'critical':
            await this.alerting.sendCritical({ title: job.data.title, message: job.data.message });
            break;
          case 'warn':
            await this.alerting.sendWarn({ title: job.data.title, message: job.data.message });
            break;
          default:
            this.logger.log(`[Alerts] ${job.data.title}: ${job.data.message}`);
        }
        this.logger.debug(`[Alerts] Job ${job.id} dispatched`);
      },
      {
        connection: connection as any,
        concurrency: 10,
        limiter: { max: 50, duration: 60_000 },
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `[Alerts] Job ${job?.id} failed attempt ${job?.attemptsMade}: ${err.message}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
