// workers/video-pipeline.processor.ts
import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { VideoPipelineService } from '../video-pipeline.service';
import { CanonicalQueue } from '../../queue/canonical-queues';

@Processor(CanonicalQueue.CREATIVE_GENERATION)   // V61.1 fix: video gen belongs on creative queue
export class VideoPipelineProcessor {
  private readonly logger = new Logger(VideoPipelineProcessor.name);

  constructor(private readonly orchestrator: VideoPipelineService) {}

  // @Process removed: @nestjs/bullmq routes by job.name in process() method  // job name matches orchestrator enqueue call
  async handleVideoPipeline(job: Job<{ jobId: string; input: any }>): Promise<void> {
    this.logger.log(`Processing video pipeline job: ${job.data.jobId}`);
    try {
      await this.orchestrator.execute(job.data.jobId, job.data.input);
    } catch (err) {
      this.logger.error(`Video pipeline job ${job.data.jobId} failed: ${(err as Error).message}`);
      throw err; // BullMQ will handle retry
    }
  }
}
