/**
 * HTTP client for the muapi.ai API.
 *
 * Extracted and ported to TypeScript from:
 *   open-generative-ai-main/src/lib/muapi.js  (MuapiClient class)
 *   open-generative-ai-main/packages/studio/src/muapi.js  (functional form)
 *
 * Pattern: POST to submit → poll GET /predictions/{id}/result until done.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default image model — fast, reliable, ecom-friendly */
export const DEFAULT_IMAGE_MODEL  = 'flux-schnell-image';
/** Default video model — short-form reel */
export const DEFAULT_VIDEO_MODEL  = 'seedance-lite-t2v';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImageParams {
  prompt:        string;
  model?:        string;  // endpoint id, defaults to DEFAULT_IMAGE_MODEL
  aspect_ratio?: string;  // e.g. '1:1', '9:16', '16:9'
  quality?:      string;
  resolution?:   string;
}

export interface VideoParams {
  prompt:        string;
  model?:        string;  // endpoint id, defaults to DEFAULT_VIDEO_MODEL
  aspect_ratio?: string;
  duration?:     number;  // seconds
  resolution?:   string;
}

interface SubmitResponse {
  request_id?: string;
  id?:         string;
  outputs?:    string[];
  url?:        string;
  output?:     { url?: string };
  status?:     string;
}

interface PollResponse extends SubmitResponse {
  status: string;
  error?: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

@Injectable()
export class AiMediaClient {
  private readonly logger  = new Logger(AiMediaClient.name);
  private readonly baseUrl: string;
  private readonly apiKey:  string;
  readonly isMock:          boolean;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>(
      'AI_MEDIA_BASE_URL',
      'https://api.muapi.ai',
    );
    this.apiKey  = this.config.get<string>('AI_MEDIA_API_KEY', 'mock');
    this.isMock  =
      !this.apiKey ||
      this.apiKey === 'mock' ||
      this.apiKey.toLowerCase() === 'mock';
  }

  // ── Image generation ───────────────────────────────────────────────────────

  /**
   * Submit + poll image generation.
   * Returns the CDN URL of the generated image.
   */
  async generateImage(params: ImageParams): Promise<string> {
    if (this.isMock) return this.mockImageUrl();

    const endpoint = params.model ?? DEFAULT_IMAGE_MODEL;
    const payload: Record<string, unknown> = {
      prompt:       params.prompt,
      aspect_ratio: params.aspect_ratio ?? '1:1',
      image_url:    null,
    };
    if (params.quality)    payload.quality    = params.quality;
    if (params.resolution) payload.resolution = params.resolution;

    const url = await this.submitAndPoll(endpoint, payload, 60);
    this.logger.log(`Image generated → ${url}`);
    return url;
  }

  // ── Video generation ───────────────────────────────────────────────────────

  /**
   * Submit + poll video generation.
   * Returns the CDN URL of the generated video.
   * Uses a longer poll timeout (900 attempts × 2 s ≈ 30 min max).
   */
  async generateVideo(params: VideoParams): Promise<string> {
    if (this.isMock) return this.mockVideoUrl();

    const endpoint = params.model ?? DEFAULT_VIDEO_MODEL;
    const payload: Record<string, unknown> = {
      prompt:       params.prompt,
      aspect_ratio: params.aspect_ratio ?? '9:16',
      duration:     params.duration     ?? 10,
    };
    if (params.resolution) payload.resolution = params.resolution;

    const url = await this.submitAndPoll(endpoint, payload, 900);
    this.logger.log(`Video generated → ${url}`);
    return url;
  }

  // ── File upload ────────────────────────────────────────────────────────────

  /**
   * Uploads a binary buffer to muapi CDN and returns the hosted URL.
   * Used when product images need to be uploaded before I2V generation.
   */
  async uploadFile(
    buffer:   Buffer,
    filename: string,
    mimeType: string,
  ): Promise<string> {
    if (this.isMock) return `https://mock.cdn.com/uploads/${filename}`;

    const formData = new FormData();
    const blob     = new Blob([new Uint8Array(buffer)], { type: mimeType });
    formData.append('file', blob, filename);

    const res = await axios.post<{ url?: string; file_url?: string }>(
      `${this.baseUrl}/api/v1/upload_file`,
      formData,
      { headers: { 'x-api-key': this.apiKey } },
    );

    const fileUrl = res.data.url ?? res.data.file_url;
    if (!fileUrl) throw new Error('No URL returned from file upload');
    return fileUrl;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Submit a generation request then poll until done.
   * Mirrors pollForResult() from source muapi.js.
   */
  private async submitAndPoll(
    endpoint:    string,
    payload:     Record<string, unknown>,
    maxAttempts: number,
  ): Promise<string> {
    // Step 1 – submit
    const submitRes = await axios.post<SubmitResponse>(
      `${this.baseUrl}/api/v1/${endpoint}`,
      payload,
      { headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey } },
    );

    const submitData = submitRes.data;
    this.logger.debug(`[muapi] Submit response: ${JSON.stringify(submitData)}`);

    // Some endpoints return the result directly (no polling needed)
    const directUrl = this.extractUrl(submitData);
    if (directUrl) return directUrl;

    const requestId = submitData.request_id ?? submitData.id;
    if (!requestId) {
      throw new Error(
        `muapi: no request_id in submit response for endpoint "${endpoint}"`,
      );
    }

    // Step 2 – poll
    return this.poll(requestId, maxAttempts);
  }

  /** Poll /predictions/{requestId}/result until status = completed/succeeded */
  private async poll(requestId: string, maxAttempts: number): Promise<string> {
    const pollUrl = `${this.baseUrl}/api/v1/predictions/${requestId}/result`;
    const interval = 2_000; // 2 s between polls (matching source)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise<void>((r) => setTimeout(r, interval));
      this.logger.debug(`[muapi] Poll attempt ${attempt}/${maxAttempts}`);

      try {
        const res  = await axios.get<PollResponse>(pollUrl, {
          headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        });
        const data   = res.data;
        const status = (data.status ?? '').toLowerCase();

        if (
          status === 'completed' ||
          status === 'succeeded'  ||
          status === 'success'
        ) {
          const url = this.extractUrl(data);
          if (!url) throw new Error('muapi: generation completed but no output URL');
          return url;
        }

        if (status === 'failed' || status === 'error') {
          throw new Error(
            `muapi: generation failed — ${data.error ?? 'unknown error'}`,
          );
        }
        // else: still processing — keep polling
      } catch (err) {
        const axErr = err as AxiosError;
        // 5xx → transient, keep going
        if (axErr.response && axErr.response.status >= 500 && attempt < maxAttempts) {
          this.logger.warn(`[muapi] Poll 5xx on attempt ${attempt}, retrying…`);
          continue;
        }
        if (attempt === maxAttempts) throw err;
      }
    }

    throw new Error(
      `muapi: generation timed out after ${maxAttempts} polling attempts`,
    );
  }

  /** Extract CDN URL from submit or poll response */
  private extractUrl(data: SubmitResponse): string | null {
    return (
      data.outputs?.[0] ??
      data.url          ??
      data.output?.url  ??
      null
    );
  }

  private mockImageUrl(): string {
    const ts = Date.now();
    this.logger.debug(`[muapi MOCK] Returning mock image URL`);
    return `https://mock.image.com/ad-${ts}.jpg`;
  }

  private mockVideoUrl(): string {
    const ts = Date.now();
    this.logger.debug(`[muapi MOCK] Returning mock video URL`);
    return `https://mock.video.com/ad-${ts}.mp4`;
  }
}
