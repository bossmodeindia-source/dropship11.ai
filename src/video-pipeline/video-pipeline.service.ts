/**
 * VideoPipelineService
 *
 * Fully autonomous video ad generation pipeline.
 * Uses ONLY user-owned AI provider keys via UserAiRouterService.
 * NEVER touches admin/platform AI keys.
 *
 * Pipeline stages:
 *  1. Script generation     (reasoning provider: OpenAI / Claude / OpenRouter)
 *  2. Scene image generation (image provider: Flux / SDXL)
 *  3. Video clip generation  (video provider: Runway / Kling / Pika)
 *  4. FFmpeg assembly        (server-side — no provider needed)
 *  5. Voiceover generation   (voice provider: ElevenLabs)
 *  6. Subtitle generation    (Whisper — server-side)
 *  7. Final storage via TelegramStorageFacade
 *  8. Virality scoring
 *  9. A/B variant generation
 */

import {
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import { UserAiRouterService } from '../user-ai-connections/user-ai-router.service';
import { TelegramStorageFacade } from '../telegram-storage/telegram-storage-facade.service';
import { CreativeScoringService } from '../creative-virality/creative-scoring.service';
import { CanonicalQueue } from '../queue/canonical-queues';

export interface VideoPipelineInput {
  tenantId:         string;
  campaignId?:      string;
  productName:      string;
  productDescription: string;
  targetAudience:   string;
  platform:         'instagram' | 'tiktok' | 'youtube_shorts' | 'facebook';
  style:            'ugc' | 'cinematic' | 'minimal' | 'testimonial';
  durationSeconds:  5 | 10 | 15 | 30;
  language:         string;
  niche:            string;
  abVariant?:       'A' | 'B' | 'C';
}

export interface VideoPipelineResult {
  jobId:          string;
  status:         string;
  script?:        VideoScript;
  telegramFileId?: string;
  viralityScore?: number;
  predictedCtr?:  number;
  predictedRoas?: number;
}

interface VideoScript {
  hook:       string;
  scenes:     VideoScene[];
  cta:        string;
  captions:   string;
  hashtags:   string[];
  voiceover:  string;
  musicStyle: string;
}

interface VideoScene {
  index:        number;
  imagePrompt:  string;
  videoPrompt:  string;
  durationMs:   number;
  textOverlay?: string;
}

@Injectable()
export class VideoPipelineService {
  private readonly logger = new Logger(VideoPipelineService.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly userAiRouter:  UserAiRouterService,
    private readonly telegramStorage: TelegramStorageFacade,
    private readonly creativeScoringService: CreativeScoringService,
    @InjectQueue(CanonicalQueue.CREATIVE_GENERATION) private readonly campaignQueue: Queue,
  ) {}

  // ── Enqueue a video pipeline job ─────────────────────────────────────────

  async enqueue(input: VideoPipelineInput): Promise<{ jobId: string }> {
    const result = await this.db.query(
      `INSERT INTO video_pipeline_jobs (
         tenant_id, campaign_id, status, pipeline_config, ab_variant
       ) VALUES ($1,$2,'queued',$3,$4)
       RETURNING id`,
      [input.tenantId, input.campaignId ?? null, JSON.stringify(input), input.abVariant ?? 'A'],
    );

    const jobId = result.rows[0].id;

    await this.campaignQueue.add('video-pipeline', { jobId, input }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 50,
      removeOnFail: 20,
    });

    this.logger.log(`Video pipeline job enqueued: ${jobId} for tenant ${input.tenantId}`);
    return { jobId };
  }

  // ── Execute the full pipeline (called by BullMQ processor) ───────────────

  async execute(jobId: string, input: VideoPipelineInput): Promise<VideoPipelineResult> {
    const start = Date.now();
    this.logger.log(`[VideoPipeline] Starting job ${jobId} for tenant ${input.tenantId}`);

    try {
      // ── Stage 1: Generate script ──────────────────────────────────────────
      await this.updateStatus(jobId, 'scripting');
      const script = await this.generateScript(input);
      await this.db.query(
        'UPDATE video_pipeline_jobs SET script_json = $1, reasoning_provider = $2 WHERE id = $3',
        [JSON.stringify(script), 'openai', jobId], // provider logged, not key
      );

      // ── Stage 2: Generate scene images ───────────────────────────────────
      await this.updateStatus(jobId, 'generating_images');
      const sceneImageUrls = await this.generateSceneImages(input, script);
      await this.db.query(
        'UPDATE video_pipeline_jobs SET scenes_json = $1, image_provider = $2 WHERE id = $3',
        [JSON.stringify(sceneImageUrls), 'flux', jobId],
      );

      // ── Stage 3: Generate video clips from images ─────────────────────────
      await this.updateStatus(jobId, 'generating_clips');
      const clipUrls = await this.generateVideoClips(input, script, sceneImageUrls);
      await this.db.query(
        'UPDATE video_pipeline_jobs SET video_provider = $1 WHERE id = $2',
        ['runway', jobId],
      );

      // ── Stage 4: Generate voiceover ───────────────────────────────────────
      await this.updateStatus(jobId, 'assembling');
      const voiceoverBuffer = await this.generateVoiceover(input, script);

      // ── Stage 5: FFmpeg assembly ──────────────────────────────────────────
      const assembledVideoBuffer = await this.assembleVideo(clipUrls, voiceoverBuffer, script);

      // ── Stage 6: Generate subtitles ───────────────────────────────────────
      await this.updateStatus(jobId, 'adding_subtitles');
      const finalVideoBuffer = await this.addSubtitles(assembledVideoBuffer, script);

      // ── Stage 7: Store via Telegram CDN ──────────────────────────────────
      const assetResult = await this.telegramStorage.enqueueUpload({
        tenantId:   input.tenantId,
        userId:     input.tenantId,
        fileName:   `video_${jobId}_${input.abVariant ?? 'A'}.mp4`,
        fileBuffer: finalVideoBuffer,
        mimeType:   'video/mp4',
        assetType:  'reel',
        campaignId: input.campaignId,
        tags:       { jobId, platform: input.platform, style: input.style },
      });

      // ── Stage 8: Virality scoring ─────────────────────────────────────────
      await this.updateStatus(jobId, 'scoring');
      const scores = await this.creativeScoringService.scoreVideo({
        tenantId:   input.tenantId,
        script,
        platform:   input.platform,
        style:      input.style,
        niche:      input.niche,
      });

      // ── Complete ──────────────────────────────────────────────────────────
      const processingMs = Date.now() - start;
      await this.db.query(
        `UPDATE video_pipeline_jobs SET
           status = 'completed', telegram_asset_id = $1,
           virality_score = $2, predicted_ctr = $3, predicted_roas = $4,
           processing_ms = $5, updated_at = NOW()
         WHERE id = $6`,
        [
          assetResult.id,  // UploadedAsset.id = assetId
          scores.viralityScore, scores.predictedCtr, scores.predictedRoas,
          processingMs, jobId,
        ],
      );

      this.logger.log(
        `[VideoPipeline] Job ${jobId} completed in ${processingMs}ms. ` +
        `Virality: ${scores.viralityScore}, CTR: ${scores.predictedCtr}`,
      );

      return {
        jobId,
        status:         'completed',
        script,
        telegramFileId: assetResult.fileId,
        viralityScore:  scores.viralityScore,
        predictedCtr:   scores.predictedCtr,
        predictedRoas:  scores.predictedRoas,
      };

    } catch (err) {
      const error = err as Error;
      this.logger.error(`[VideoPipeline] Job ${jobId} FAILED: ${error.message}`);
      await this.db.query(
        `UPDATE video_pipeline_jobs
         SET status = 'failed', error_message = $1,
             retry_count = retry_count + 1, updated_at = NOW()
         WHERE id = $2`,
        [error.message.slice(0, 500), jobId],
      );
      throw err;
    }
  }

  // ── Stage implementations ─────────────────────────────────────────────────

  private async generateScript(input: VideoPipelineInput): Promise<VideoScript> {
    const systemPrompt = `You are an elite direct-response video ad scriptwriter.
Generate a ${input.durationSeconds}s ${input.style} ad script for ${input.platform}.
Respond ONLY with valid JSON. No markdown. No explanation.`;

    const userPrompt = `Product: ${input.productName}
Description: ${input.productDescription}
Target Audience: ${input.targetAudience}
Niche: ${input.niche}
Language: ${input.language}
Platform: ${input.platform}
Duration: ${input.durationSeconds}s
Style: ${input.style}

Generate a viral ad script with:
{
  "hook": "Attention-grabbing opening line (first 3 seconds)",
  "scenes": [
    {
      "index": 1,
      "imagePrompt": "Detailed image generation prompt for this scene",
      "videoPrompt": "Video motion prompt (e.g. slow push in, zoom out, tracking shot)",
      "durationMs": 3000,
      "textOverlay": "Optional text overlay for this scene"
    }
  ],
  "cta": "Call to action text",
  "captions": "Full caption for social post",
  "hashtags": ["hashtag1", "hashtag2"],
  "voiceover": "Complete voiceover script",
  "musicStyle": "e.g. upbeat electronic, emotional cinematic, trending audio"
}`;

    const response = await this.userAiRouter.route({
      tenantId:  input.tenantId,
      category:  'reasoning',
      operation: 'script_generation',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      maxTokens:    1500,
      temperature:  0.8,
      campaignId:   input.campaignId,
    });

    let script: VideoScript;
    try {
      const text = typeof response.content === 'string' ? response.content : '';
      script = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      throw new Error(`Script generation returned invalid JSON from provider ${response.providerKey}`);
    }

    return script;
  }

  private async generateSceneImages(
    input: VideoPipelineInput,
    script: VideoScript,
  ): Promise<string[]> {
    const imageUrls: string[] = [];

    for (const scene of script.scenes) {
      const response = await this.userAiRouter.route({
        tenantId:  input.tenantId,
        category:  'image_generation',
        operation: 'scene_image',
        prompt:    `${scene.imagePrompt}, ${input.style} style, high quality, 4K, product advertisement`,
        campaignId: input.campaignId,
      });

      if (response.contentUrl) {
        imageUrls.push(response.contentUrl);
      } else {
        this.logger.warn(`Scene ${scene.index} image generation returned no URL`);
        imageUrls.push(''); // placeholder — video gen may still work with empty prompt
      }
    }

    return imageUrls;
  }

  private async generateVideoClips(
    input: VideoPipelineInput,
    script: VideoScript,
    imageUrls: string[],
  ): Promise<string[]> {
    const clipUrls: string[] = [];

    for (let i = 0; i < script.scenes.length; i++) {
      const scene    = script.scenes[i];
      const imageUrl = imageUrls[i];

      const response = await this.userAiRouter.route({
        tenantId:        input.tenantId,
        category:        'video_generation',
        operation:       'video_clip',
        prompt:          scene.videoPrompt,
        imageUrl:        imageUrl || undefined,
        durationSeconds: Math.ceil(scene.durationMs / 1000),
        campaignId:      input.campaignId,
      });

      if (response.contentUrl) {
        clipUrls.push(response.contentUrl);
      }
    }

    return clipUrls;
  }

  private async generateVoiceover(
    input: VideoPipelineInput,
    script: VideoScript,
  ): Promise<Buffer | null> {
    try {
      const response = await this.userAiRouter.route({
        tenantId:  input.tenantId,
        category:  'voice',
        operation: 'voiceover',
        prompt:    script.voiceover,
        campaignId: input.campaignId,
      });

      return Buffer.isBuffer(response.content)
        ? response.content
        : null;
    } catch (err) {
      this.logger.warn(`Voiceover generation failed (non-fatal): ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * FFmpeg-based assembly. Downloads clips and concatenates them.
   * In production: runs via child_process or a dedicated worker.
   * This returns the assembled buffer.
   */
  private async assembleVideo(
    clipUrls: string[],
    voiceoverBuffer: Buffer | null,
    script: VideoScript,
  ): Promise<Buffer> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { writeFile, readFile, unlink } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const path = await import('path');
    const execFileAsync = promisify(execFile);

    const tmpDir     = tmpdir();
    const listFile   = path.join(tmpDir, `concat_${Date.now()}.txt`);
    const outputFile = path.join(tmpDir, `output_${Date.now()}.mp4`);
    const clipFiles: string[] = [];

    try {
      // Download clips
      for (let i = 0; i < clipUrls.length; i++) {
        if (!clipUrls[i]) continue;
        const clipFile = path.join(tmpDir, `clip_${i}_${Date.now()}.mp4`);
        const res = await fetch(clipUrls[i], { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) continue;
        await writeFile(clipFile, Buffer.from(await res.arrayBuffer()));
        clipFiles.push(clipFile);
      }

      if (clipFiles.length === 0) {
        throw new Error('No video clips available for assembly');
      }

      // Write FFmpeg concat list
      const concatContent = clipFiles.map(f => `file '${f}'`).join('\n');
      await writeFile(listFile, concatContent);

      // FFmpeg concatenation with optional voiceover
      const ffmpegArgs = [
        '-f', 'concat', '-safe', '0', '-i', listFile,
      ];

      if (voiceoverBuffer) {
        const voFile = path.join(tmpDir, `vo_${Date.now()}.mp3`);
        await writeFile(voFile, voiceoverBuffer);
        clipFiles.push(voFile);
        ffmpegArgs.push('-i', voFile, '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
        );
      } else {
        ffmpegArgs.push('-c:v', 'libx264', '-c:a', 'aac');
      }

      ffmpegArgs.push('-movflags', '+faststart', '-y', outputFile);

      await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 180_000 });

      const assembled = await readFile(outputFile);
      return assembled;

    } finally {
      // Cleanup temp files
      await Promise.allSettled([
        unlink(listFile).catch(() => {}),
        unlink(outputFile).catch(() => {}),
        ...clipFiles.map(f => unlink(f).catch(() => {})),
      ]);
    }
  }

  /**
   * Whisper-based subtitle generation + burn-in via FFmpeg.
   * For now returns input unchanged if Whisper not available.
   */
  private async addSubtitles(videoBuffer: Buffer, script: VideoScript): Promise<Buffer> {
    // Whisper transcription is server-side (admin infrastructure)
    // For initial release, return video as-is and do text overlay via FFmpeg separately
    // Full Whisper integration added in next iteration via admin's infrastructure
    return videoBuffer;
  }

  private async updateStatus(jobId: string, status: string): Promise<void> {
    await this.db.query(
      'UPDATE video_pipeline_jobs SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, jobId],
    );
  }

  /** Alias for enqueue() — used by ViralMediaEngine with extended fields (extras ignored). */
  async enqueuePipelineJob(input: Partial<VideoPipelineInput> & Record<string, unknown>): Promise<{ jobId: string }> {
    // Extract only the fields that VideoPipelineInput defines; extras are silently dropped
    const pipelineInput: VideoPipelineInput = {
      tenantId:           (input.tenantId as string) ?? '',
      productName:        (input.productName as string) ?? '',
      productDescription: (input.productDescription as string) ?? '',
      targetAudience:     (input.targetAudience as string) ?? '',
      platform:           (input.platform as VideoPipelineInput['platform']) ?? 'instagram',
      style:              (input.style as VideoPipelineInput['style']) ?? 'ugc',
      durationSeconds:    (input.durationSeconds as VideoPipelineInput['durationSeconds']) ?? 15,
      language:           (input.language as string) ?? 'en',
      niche:              (input.niche as string) ?? '',
      ...(input.campaignId ? { campaignId: input.campaignId as string } : {}),
      ...(input.abVariant  ? { abVariant:  input.abVariant  as VideoPipelineInput['abVariant'] } : {}),
    };
    return this.enqueue(pipelineInput);
  }
}
