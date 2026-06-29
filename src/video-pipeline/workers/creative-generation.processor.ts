/**
 * CreativeGenerationProcessor
 *
 * Bridges the gap between:
 *   UnifiedCommerceOrchestrator  (enqueues 'generate' on CREATIVE_GENERATION)
 *     ↓
 *   VideoPipelineService    (executes script→image→video→CDN pipeline)
 *
 * WHY THIS EXISTS:
 *   The UnifiedCommerceOrchestrator dispatches to the canonical CREATIVE_GENERATION
 *   queue using job name 'generate'. Previously no consumer existed for this job
 *   name — jobs piled up unprocessed, silently breaking the entire autonomous
 *   commerce loop. This processor is the missing consumer.
 *
 * JOB PAYLOAD CONTRACT (from UnifiedCommerceOrchestrator):
 * {
 *   tenantId:       string   (required)
 *   botId?:         string
 *   cycleId?:       string
 *   productName?:   string
 *   productDesc?:   string
 *   niche?:         string
 *   audience?:      string
 *   platform?:      'instagram'|'tiktok'|'youtube_shorts'|'facebook'
 *   style?:         'ugc'|'cinematic'|'minimal'|'testimonial'
 *   dryRun?:        boolean
 * }
 *
 * SECURITY: Uses ONLY user-owned AI provider keys via VideoPipelineService
 * → UserAiRouterService. NEVER falls back to admin keys.
 */

import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CanonicalQueue } from '../../queue/canonical-queues';
import { VideoPipelineService, VideoPipelineInput } from '../video-pipeline.service';

const DEFAULT_PLATFORM: VideoPipelineInput['platform'] = 'instagram';
const DEFAULT_STYLE:    VideoPipelineInput['style']    = 'ugc';
const DEFAULT_DURATION: VideoPipelineInput['durationSeconds'] = 15;

interface GenerateJobData {
  tenantId:      string;
  botId?:        string;
  cycleId?:      string;
  productName?:  string;
  productDesc?:  string;
  niche?:        string;
  audience?:     string;
  platform?:     VideoPipelineInput['platform'];
  style?:        VideoPipelineInput['style'];
  durationSeconds?: VideoPipelineInput['durationSeconds'];
  language?:     string;
  campaignId?:   string;
  dryRun?:       boolean;
}

@Processor(CanonicalQueue.CREATIVE_GENERATION)
export class CreativeGenerationProcessor {
  private readonly logger = new Logger(CreativeGenerationProcessor.name);

  constructor(private readonly videoPipeline: VideoPipelineService) {}

  /**
   * 'generate' — dispatched by UnifiedCommerceOrchestrator creative step.
   * Translates the orchestrator payload into a VideoPipelineInput and
   * calls enqueue() which persists state + dispatches the 'video-pipeline'
   * sub-job to the same queue.
   */
  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleGenerate(job: Job<GenerateJobData>): Promise<void> {
    const { data } = job;

    if (!data.tenantId) {
      this.logger.error(`Job ${job.id} missing tenantId — skipping`);
      return;
    }

    if (data.dryRun) {
      this.logger.log(`[DRY RUN] Skipping video generation for tenant ${data.tenantId}`);
      return;
    }

    this.logger.log(
      `[${CanonicalQueue.CREATIVE_GENERATION}/generate] tenant=${data.tenantId} ` +
      `product="${data.productName ?? 'unknown'}" cycleId=${data.cycleId ?? 'n/a'}`,
    );

    const input: VideoPipelineInput = {
      tenantId:           data.tenantId,
      campaignId:         data.campaignId ?? data.cycleId,
      productName:        data.productName      ?? 'Product',
      productDescription: data.productDesc      ?? '',
      targetAudience:     data.audience         ?? 'general consumers',
      platform:           data.platform         ?? DEFAULT_PLATFORM,
      style:              data.style            ?? DEFAULT_STYLE,
      durationSeconds:    data.durationSeconds  ?? DEFAULT_DURATION,
      language:           data.language         ?? 'en',
      niche:              data.niche            ?? 'general',
      abVariant:          'A',  // orchestrator always starts with variant A
    };

    try {
      const { jobId } = await this.videoPipeline.enqueue(input);
      this.logger.log(
        `Video pipeline job ${jobId} enqueued for tenant ${data.tenantId} ` +
        `(cycle ${data.cycleId ?? 'n/a'})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to enqueue video pipeline for tenant ${data.tenantId}: ${(err as Error).message}`,
      );
      throw err; // BullMQ retries with exponential backoff
    }
  }

  /**
   * 'score' — dispatched when a completed creative needs virality re-scoring
   * after actual performance data comes in (learning loop feedback).
   */
  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleScore(job: Job<{ tenantId: string; jobId: string; actualCtr?: number; actualRoas?: number }>): Promise<void> {
    this.logger.log(
      `[${CanonicalQueue.CREATIVE_GENERATION}/score] jobId=${job.data.jobId} ` +
      `actualCtr=${job.data.actualCtr} actualRoas=${job.data.actualRoas}`,
    );
    // Performance feedback is written by UserAiRouterService.recordActualPerformance()
    // which is already called from MetaPerformanceScheduler on ROAS data sync.
    // This job is a no-op hook for future ML feedback loop extensions.
  }

  /**
   * 'ab-test' — generate B and C variants for a winning creative.
   */
  // @Process removed: @nestjs/bullmq routes by job.name in process() method
  async handleAbTest(job: Job<GenerateJobData & { sourceJobId: string }>): Promise<void> {
    const { data } = job;

    if (!data.tenantId || !data.sourceJobId) {
      this.logger.warn(`ab-test job ${job.id} missing required fields — skipping`);
      return;
    }

    this.logger.log(
      `[${CanonicalQueue.CREATIVE_GENERATION}/ab-test] Generating B+C variants ` +
      `for sourceJob=${data.sourceJobId} tenant=${data.tenantId}`,
    );

    // Generate variant B and C sequentially (avoid provider rate limits)
    for (const variant of ['B', 'C'] as const) {
      const input: VideoPipelineInput = {
        tenantId:           data.tenantId,
        campaignId:         data.campaignId ?? data.cycleId,
        productName:        data.productName      ?? 'Product',
        productDescription: data.productDesc      ?? '',
        targetAudience:     data.audience         ?? 'general consumers',
        platform:           data.platform         ?? DEFAULT_PLATFORM,
        style:              data.style            ?? DEFAULT_STYLE,
        durationSeconds:    data.durationSeconds  ?? DEFAULT_DURATION,
        language:           data.language         ?? 'en',
        niche:              data.niche            ?? 'general',
        abVariant:          variant,
      };

      try {
        const { jobId } = await this.videoPipeline.enqueue(input);
        this.logger.log(`A/B variant ${variant} enqueued: jobId=${jobId}`);
      } catch (err) {
        this.logger.error(`Failed to enqueue variant ${variant}: ${(err as Error).message}`);
        // Don't throw — partial variant generation is acceptable
      }
    }
  }
}
