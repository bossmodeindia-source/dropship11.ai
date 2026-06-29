/**
 * OrganicPostingProcessor
 *
 * Consumes CanonicalQueue.ORGANIC_POSTING — the direct post dispatch queue.
 *
 * WHY THIS EXISTS:
 *   The ORGANIC_POSTING queue receives 'post' jobs from:
 *   1. QueueOrchestratorService.enqueueOrganicPost()  — direct publish requests
 *   2. OrganicScheduler (V61.1)                       — scheduled post dispatch
 *      for organic_publish_jobs rows with status='scheduled'
 *
 *   Previously this queue had no consumer. Jobs accumulated silently.
 *
 * SECURITY: Uses USER social tokens via TenantOrganicPublisherService.
 * Admin keys are NEVER used for user post dispatch.
 *
 * JOB PAYLOAD CONTRACT:
 *   name='post': full OrganicPublishRequest-compatible shape
 *   name='retry-scheduled': { publishJobId } — picks up from organic_publish_jobs
 */

import { Processor } from '@nestjs/bullmq';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { Pool } from 'pg';
import { CanonicalQueue } from '../queue/canonical-queues';
import {
  TenantOrganicPublisherService,
  OrganicPublishRequest,
} from '../organic/tenant-organic-publisher.service';
import { DB_POOL } from '../common/database/database.module';

interface PostJobData extends OrganicPublishRequest {
  publishJobId?: string;   // if re-dispatching a scheduled job from organic_publish_jobs
}

interface RetryScheduledJobData {
  publishJobId: string;
  tenantId:     string;
}

@Processor(CanonicalQueue.ORGANIC_POSTING)
export class OrganicPostingProcessor {
  private readonly logger = new Logger(OrganicPostingProcessor.name);

  constructor(
    private readonly organic: TenantOrganicPublisherService,
    @Inject(DB_POOL) private readonly db: Pool,
  ) {}

  /**
   * 'post' — direct organic post dispatch.
   * Accepts the same shape as OrganicPublishRequest.
   */
  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handlePost(job: Job<PostJobData>): Promise<void> {
    const { data } = job;

    if (!data.tenantId) {
      this.logger.error(`[organic-posting/post] Job ${job.id} missing tenantId — skipping`);
      return;
    }

    this.logger.log(
      `[organic-posting/post] tenant=${data.tenantId} platform=${data.platform} ` +
      `hasVideo=${!!data.videoUrl} hasSchedule=${!!data.scheduleAt}`,
    );

    const result = await this.organic.publish({
      tenantId:   data.tenantId,
      platform:   data.platform,
      videoUrl:   data.videoUrl,
      videoJobId: data.videoJobId,
      caption:    data.caption ?? '',
      hashtags:   data.hashtags ?? [],
      campaignId: data.campaignId,
      scheduleAt: data.scheduleAt ? new Date(data.scheduleAt as unknown as string) : undefined,
    });

    if (result.status === 'failed') {
      throw new Error(`Organic post failed: ${result.error}`);
    }

    this.logger.log(
      `[organic-posting/post] ${result.status} on ${result.platform} ` +
      `postId=${result.platformPostId} tenant=${data.tenantId}`,
    );
  }

  /**
   * 'retry-scheduled' — dispatched by OrganicSchedulerV61 for rows in
   * organic_publish_jobs that have passed their scheduled_at time.
   *
   * Reads the full row from DB and re-dispatches via TenantOrganicPublisherService.
   */
  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleRetryScheduled(job: Job<RetryScheduledJobData>): Promise<void> {
    const { publishJobId, tenantId } = job.data;

    const row = await this.db.query(
      `SELECT * FROM organic_publish_jobs WHERE id=$1 AND tenant_id=$2 AND status='scheduled'`,
      [publishJobId, tenantId],
    );

    if (!row.rows[0]) {
      this.logger.warn(
        `[retry-scheduled] Job ${publishJobId} not found or not in scheduled state — skipping`,
      );
      return;
    }

    const post = row.rows[0];

    this.logger.log(
      `[retry-scheduled] Dispatching scheduled post ${publishJobId} ` +
      `tenant=${tenantId} platform=${post.platform}`,
    );

    // Mark as 'publishing' atomically before dispatch to prevent duplicate runs
    const claimed = await this.db.query(
      `UPDATE organic_publish_jobs
       SET status='publishing', updated_at=NOW()
       WHERE id=$1 AND status='scheduled'
       RETURNING id`,
      [publishJobId],
    );

    if (!claimed.rows[0]) {
      this.logger.warn(`[retry-scheduled] Post ${publishJobId} already claimed by another worker`);
      return;
    }

    const result = await this.organic.publish({
      tenantId,
      platform:   post.platform,
      videoJobId: post.video_job_id ?? undefined,
      caption:    post.caption ?? '',
      hashtags:   post.hashtags ?? [],
      campaignId: post.campaign_id ?? undefined,
      // No scheduleAt — dispatch immediately
    });

    if (result.status === 'failed') {
      await this.db.query(
        `UPDATE organic_publish_jobs SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2`,
        [(result.error ?? 'Unknown error').slice(0, 500), publishJobId],
      );
      throw new Error(`Scheduled post ${publishJobId} failed: ${result.error}`);
    }

    this.logger.log(
      `[retry-scheduled] Published ${publishJobId} → ${result.platformPostId} on ${post.platform}`,
    );
  }
}
