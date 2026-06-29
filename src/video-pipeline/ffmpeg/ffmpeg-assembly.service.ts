/**
 * FFmpegAssemblyService
 *
 * Server-side video assembly pipeline using FFmpeg.
 * Runs entirely on the platform — no external API required.
 *
 * Pipeline:
 *   1. Download scene images/clips from URLs or Telegram file_ids
 *   2. Generate per-scene video clips (ffmpeg image→video with Ken Burns)
 *   3. Concatenate all scene clips
 *   4. Overlay voiceover audio track
 *   5. Add background music (ducked under voiceover)
 *   6. Burn subtitle SRT onto video
 *   7. Add CTA text overlay (bottom thirds)
 *   8. Add watermark if configured
 *   9. Export platform-optimal format (9:16 for Reels/TikTok, 1:1 for FB)
 *  10. Generate thumbnail from best frame
 */
import { Injectable, Logger } from '@nestjs/common';
import { promises as fs }     from 'fs';
import * as path              from 'path';
import * as os                from 'os';
import { spawn }              from 'child_process';
import axios from 'axios';


export interface AssemblyInput {
  jobId:           string;
  scenes:          SceneAsset[];
  voiceoverUrl?:   string;
  musicUrl?:       string;
  subtitleSrt?:    string;
  ctaText?:        string;
  watermarkText?:  string;
  platform:        'instagram' | 'tiktok' | 'youtube_shorts' | 'facebook';
  durationSeconds: number;
  style:           'ugc' | 'cinematic' | 'minimal' | 'testimonial';
}

export interface SceneAsset {
  index:          number;
  imageUrl?:      string;
  videoUrl?:      string;
  durationMs:     number;
  textOverlay?:   string;
  transitionType: 'cut' | 'fade' | 'slide' | 'zoom';
}

export interface AssemblyResult {
  outputPath:    string;
  thumbnailPath: string;
  durationMs:    number;
  fileSizeBytes: number;
  width:         number;
  height:        number;
  format:        string;
}

// Platform-specific output specs
const PLATFORM_SPECS: Record<string, { w: number; h: number; fps: number; bitrate: string }> = {
  instagram:      { w: 1080, h: 1920, fps: 30, bitrate: '4M' },
  tiktok:         { w: 1080, h: 1920, fps: 30, bitrate: '4M' },
  youtube_shorts: { w: 1080, h: 1920, fps: 30, bitrate: '6M' },
  facebook:       { w: 1080, h: 1080, fps: 30, bitrate: '4M' },
};

@Injectable()
export class FFmpegAssemblyService {
  private readonly logger = new Logger(FFmpegAssemblyService.name);

  /* eslint-disable */

  // ── Main assembly entry point ─────────────────────────────────────────────
  async assemble(input: AssemblyInput): Promise<AssemblyResult> {
    const workDir = path.join(os.tmpdir(), `video-${input.jobId}`);
    await fs.mkdir(workDir, { recursive: true });

    this.logger.log(`[FFmpeg] Assembling job ${input.jobId} in ${workDir}`);

    try {
      // 1. Download all assets
      const assetPaths = await this.downloadAssets(input.scenes, workDir);

      // 2. Build per-scene clips
      const scenePaths = await this.buildSceneClips(input.scenes, assetPaths, workDir, input.platform);

      // 3. Write concat file
      const concatFile = path.join(workDir, 'concat.txt');
      await fs.writeFile(concatFile, scenePaths.map(p => `file '${p}'`).join('\n'));

      // 4. Concatenate scenes
      const concatPath = path.join(workDir, 'concat.mp4');
      await this.runFFmpeg([
        '-f', 'concat', '-safe', '0', '-i', concatFile,
        '-c', 'copy', concatPath,
      ]);

      // 5. Mix audio (voiceover + music)
      let videoWithAudio = concatPath;
      if (input.voiceoverUrl ?? input.musicUrl) {
        videoWithAudio = await this.mixAudio(concatPath, input, workDir);
      }

      // 6. Burn subtitles
      let videoWithSubs = videoWithAudio;
      if (input.subtitleSrt) {
        videoWithSubs = await this.burnSubtitles(videoWithAudio, input.subtitleSrt, workDir);
      }

      // 7. Add CTA overlay + watermark + final encode
      const spec = PLATFORM_SPECS[input.platform] ?? PLATFORM_SPECS['instagram'];
      const outputPath = path.join(workDir, 'final.mp4');
      await this.finalEncode(videoWithSubs, outputPath, input, spec);

      // 8. Generate thumbnail
      const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
      await this.generateThumbnail(outputPath, thumbnailPath);

      // 9. Collect stats
      const stat = await fs.stat(outputPath);

      this.logger.log(`[FFmpeg] Job ${input.jobId} assembled: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

      return {
        outputPath,
        thumbnailPath,
        durationMs:    input.durationSeconds * 1000,
        fileSizeBytes: stat.size,
        width:         spec.w,
        height:        spec.h,
        format:        'mp4',
      };

    } catch (err) {
      this.logger.error(`[FFmpeg] Assembly failed for job ${input.jobId}: ${(err as Error).message}`);
      throw err;
    }
  }

  // ── Download all scene assets ─────────────────────────────────────────────
  private async downloadAssets(
    scenes: SceneAsset[],
    workDir: string,
  ): Promise<Map<number, string>> {
    const paths = new Map<number, string>();

    await Promise.all(scenes.map(async (scene) => {
      const url = scene.videoUrl ?? scene.imageUrl;
      if (!url) return;

      const ext  = scene.videoUrl ? 'mp4' : 'jpg';
      const dest = path.join(workDir, `scene-${scene.index}-raw.${ext}`);

      const resp = await axios.get(url, { responseType: 'arraybuffer' });
      await fs.writeFile(dest, Buffer.from((resp as {data: ArrayBuffer}).data));
      paths.set(scene.index, dest);
    }));

    return paths;
  }

  // ── Build per-scene video clips from images ───────────────────────────────
  private async buildSceneClips(
    scenes:     SceneAsset[],
    assets:     Map<number, string>,
    workDir:    string,
    platform:   string,
  ): Promise<string[]> {
    const spec = PLATFORM_SPECS[platform] ?? PLATFORM_SPECS['instagram'];
    const clips: string[] = [];

    for (const scene of scenes.sort((a, b) => a.index - b.index)) {
      const assetPath = assets.get(scene.index);
      if (!assetPath) continue;

      const clipPath  = path.join(workDir, `scene-${scene.index}.mp4`);
      const durSec    = scene.durationMs / 1000;

      if (scene.videoUrl) {
        // Re-encode existing video clip to match spec
        await this.runFFmpeg([
          '-i', assetPath,
          '-t', String(durSec),
          '-vf', `scale=${spec.w}:${spec.h}:force_original_aspect_ratio=decrease,pad=${spec.w}:${spec.h}:(ow-iw)/2:(oh-ih)/2`,
          '-r', String(spec.fps),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-an', clipPath,
        ]);
      } else {
        // Image → video with Ken Burns zoom effect
        const zoomFilter = this.getKenBurnsFilter(scene.index, spec.w, spec.h, durSec);
        const args: string[] = [
          '-loop', '1', '-i', assetPath,
          '-t', String(durSec),
          '-vf', zoomFilter,
          '-r', String(spec.fps),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-pix_fmt', 'yuv420p',
        ];
        // Add text overlay if present
        if (scene.textOverlay) {
          args.push('-vf', `${zoomFilter},drawtext=text='${scene.textOverlay.replace(/'/g,"\\'")}':fontcolor=white:fontsize=48:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.8`);
        }
        args.push('-an', clipPath);
        await this.runFFmpeg(args);
      }

      clips.push(clipPath);
    }

    return clips;
  }

  // ── Mix voiceover + background music ─────────────────────────────────────
  private async mixAudio(
    videoPath: string,
    input:     AssemblyInput,
    workDir:   string,
  ): Promise<string> {
    const outputPath = path.join(workDir, 'with-audio.mp4');
    const args: string[] = ['-i', videoPath];
    let filterComplex = '';
    let mapArgs: string[] = [];

    if (input.voiceoverUrl && input.musicUrl) {
      // Download both audio tracks
      const voPath = path.join(workDir, 'voiceover.mp3');
      const muPath = path.join(workDir, 'music.mp3');
      await this.downloadFile(input.voiceoverUrl, voPath);
      await this.downloadFile(input.musicUrl, muPath);

      args.push('-i', voPath, '-i', muPath);
      // Duck music under voiceover: voiceover at 1.0, music at 0.15
      filterComplex = '[2:a]volume=0.15[music];[1:a][music]amix=inputs=2:duration=shortest[aout]';
      mapArgs = ['-map', '0:v', '-map', '[aout]'];
    } else if (input.voiceoverUrl) {
      const voPath = path.join(workDir, 'voiceover.mp3');
      await this.downloadFile(input.voiceoverUrl, voPath);
      args.push('-i', voPath);
      mapArgs = ['-map', '0:v', '-map', '1:a'];
    } else if (input.musicUrl) {
      const muPath = path.join(workDir, 'music.mp3');
      await this.downloadFile(input.musicUrl, muPath);
      args.push('-i', muPath);
      filterComplex = '[1:a]volume=0.5[aout]';
      mapArgs = ['-map', '0:v', '-map', '[aout]'];
    }

    if (filterComplex) args.push('-filter_complex', filterComplex);
    args.push(...mapArgs, '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath);

    await this.runFFmpeg(args);
    return outputPath;
  }

  // ── Burn SRT subtitles ────────────────────────────────────────────────────
  private async burnSubtitles(
    videoPath: string,
    srtContent: string,
    workDir:    string,
  ): Promise<string> {
    const srtPath    = path.join(workDir, 'subtitles.srt');
    const outputPath = path.join(workDir, 'with-subs.mp4');
    await fs.writeFile(srtPath, srtContent);

    // Word-level subtitle styling: large, bold, bottom-centre, with black outline
    await this.runFFmpeg([
      '-i', videoPath,
      '-vf', `subtitles='${srtPath.replace(/\\/g,'/')}':force_style='FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,Outline=3,Shadow=1,Alignment=2,MarginV=60'`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'copy', outputPath,
    ]);

    return outputPath;
  }

  // ── Final encode with CTA + watermark ────────────────────────────────────
  private async finalEncode(
    videoPath:  string,
    outputPath: string,
    input:      AssemblyInput,
    spec:       { w: number; h: number; fps: number; bitrate: string },
  ): Promise<void> {
    const filters: string[] = [`scale=${spec.w}:${spec.h}:force_original_aspect_ratio=decrease,pad=${spec.w}:${spec.h}:(ow-iw)/2:(oh-ih)/2`];

    // CTA overlay — bottom thirds style
    if (input.ctaText) {
      const escaped = input.ctaText.replace(/'/g, "\\'").replace(/:/g, '\\:');
      filters.push(
        // Background pill
        `drawbox=x=(w-600)/2:y=h-180:w=600:h=70:color=0x000000AA:t=fill`,
        // CTA text
        `drawtext=text='${escaped}':fontcolor=white:fontsize=32:bold=1:x=(w-text_w)/2:y=h-158:shadowcolor=black:shadowx=2:shadowy=2`,
      );
    }

    // Watermark (subtle platform branding)
    if (input.watermarkText) {
      const esc = input.watermarkText.replace(/'/g, "\\'");
      filters.push(`drawtext=text='${esc}':fontcolor=0xFFFFFF60:fontsize=18:x=20:y=20`);
    }

    await this.runFFmpeg([
      '-i', videoPath,
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'medium', '-b:v', spec.bitrate, '-maxrate', spec.bitrate, '-bufsize', `${parseInt(spec.bitrate) * 2}M`,
      '-r', String(spec.fps),
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',  // web-optimised
      '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
  }

  // ── Generate thumbnail ────────────────────────────────────────────────────
  private async generateThumbnail(videoPath: string, thumbnailPath: string): Promise<void> {
    await this.runFFmpeg([
      '-ss', '00:00:01',
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-vf', 'scale=720:-1',
      thumbnailPath,
    ]);
  }

  // ── Ken Burns zoom filter (alternates between zoom-in and zoom-out) ───────
  private getKenBurnsFilter(index: number, w: number, h: number, durSec: number): string {
    const totalFrames = Math.round(durSec * 30);
    const zoomIn = index % 2 === 0;

    if (zoomIn) {
      return `scale=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=30`;
    } else {
      return `scale=${w * 2}:${h * 2},zoompan=z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=30`;
    }
  }

  // ── Spawn FFmpeg process ─────────────────────────────────────────────────
  private runFFmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr: string[] = [];

      proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-5).join('')}`));
        }
      });
      proc.on('error', reject);
    });
  }

  // ── Download a file ──────────────────────────────────────────────────────
  private async downloadFile(url: string, dest: string): Promise<void> {
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    await fs.writeFile(dest, Buffer.from((resp as {data: ArrayBuffer}).data));
  }

  // ── Cleanup temp directory after upload ─────────────────────────────────
  async cleanup(jobId: string): Promise<void> {
    const workDir = path.join(os.tmpdir(), `video-${jobId}`);
    await fs.rm(workDir, { recursive: true, force: true });
    this.logger.debug(`[FFmpeg] Cleaned up job ${jobId}`);
  }
}
