/**
 * TenantOrganicPublisherService
 *
 * Upgrade layer over the existing OrganicService.
 * Routes organic publishing through USER-OWNED credentials
 * fetched from UserBusinessConnectionsService — NOT env vars.
 *
 * This is the bridge between:
 *  - Legacy OrganicService (env-token based, kept for backward compat)
 *  - New multi-tenant model where each user connects their own accounts
 *
 * Handles:
 *  - Instagram Reels (via user's INSTAGRAM_ACCESS_TOKEN)
 *  - Facebook Posts (via user's FACEBOOK_PAGE_TOKEN)
 *  - TikTok Videos (via user's TIKTOK_API_KEY)
 *  - YouTube Shorts (via user's YOUTUBE_API_KEY)
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../common/database/database.module';
import { UserBusinessConnectionsService } from '../user-business-connections/user-business-connections.service';
import { TelegramStorageFacade } from '../telegram-storage/telegram-storage-facade.service';
import { CreativeScoringService } from '../creative-virality/creative-scoring.service';

export interface OrganicPublishRequest {
  tenantId:      string;
  platform:      'instagram' | 'facebook' | 'tiktok' | 'youtube_shorts';
  videoJobId?:   string;       // from video_pipeline_jobs
  videoUrl?:     string;       // direct video URL (from Telegram CDN)
  caption:       string;
  hashtags:      string[];
  scheduleAt?:   Date;         // null = post immediately
  campaignId?:   string;
}

export interface OrganicPublishResult {
  publishJobId:   string;
  platform:       string;
  status:         'published' | 'scheduled' | 'failed';
  platformPostId?: string;
  publishedAt?:   Date;
  error?:         string;
}

@Injectable()
export class TenantOrganicPublisherService {
  private readonly logger = new Logger(TenantOrganicPublisherService.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly bizConnections: UserBusinessConnectionsService,
    private readonly scoring:        CreativeScoringService,
  ) {}

  // ── Publish to a platform ─────────────────────────────────────────────────

  async publish(req: OrganicPublishRequest): Promise<OrganicPublishResult> {
    // Create job record
    const jobRow = await this.db.query(
      `INSERT INTO organic_publish_jobs (
         tenant_id, platform, video_job_id,
         caption, hashtags, scheduled_at, status, campaign_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        req.tenantId, req.platform, req.videoJobId ?? null,
        req.caption, req.hashtags,
        req.scheduleAt ?? null,
        req.scheduleAt ? 'scheduled' : 'publishing',
        req.campaignId ?? null,
      ],
    );
    const publishJobId = jobRow.rows[0].id;

    if (req.scheduleAt && req.scheduleAt > new Date()) {
      this.logger.log(`Scheduled organic post ${publishJobId} for ${req.scheduleAt.toISOString()}`);
      return { publishJobId, platform: req.platform, status: 'scheduled' };
    }

    try {
      const result = await this.dispatchToUserPlatform(req, publishJobId);
      return { publishJobId, platform: req.platform, ...result };
    } catch (err) {
      const msg = (err as Error).message;
      await this.db.query(
        `UPDATE organic_publish_jobs SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2`,
        [msg.slice(0,500), publishJobId],
      );
      return { publishJobId, platform: req.platform, status: 'failed', error: msg };
    }
  }

  // ── Dispatch to user's own platform account ───────────────────────────────

  private async dispatchToUserPlatform(
    req: OrganicPublishRequest,
    publishJobId: string,
  ): Promise<{ status: 'published'; platformPostId?: string; publishedAt: Date }> {

    const platformMap: Record<string, Parameters<typeof this.bizConnections.decryptForRuntime>[1]> = {
      instagram:      'meta_instagram',
      facebook:       'meta_facebook_page',
      tiktok:         'tiktok',
      youtube_shorts: 'youtube',
    };

    const bizPlatform = platformMap[req.platform];
    const creds = await this.bizConnections.decryptForRuntime(req.tenantId, bizPlatform);

    let platformPostId: string | undefined;

    switch (req.platform) {
      case 'instagram':
        platformPostId = await this.publishInstagram(creds, req);
        break;
      case 'facebook':
        platformPostId = await this.publishFacebook(creds, req);
        break;
      case 'tiktok':
        platformPostId = await this.publishTikTok(creds, req);
        break;
      case 'youtube_shorts':
        platformPostId = await this.publishYouTubeShorts(creds, req);
        break;
    }

    const publishedAt = new Date();
    await this.db.query(
      `UPDATE organic_publish_jobs
       SET status='published', platform_post_id=$1, published_at=$2, updated_at=NOW()
       WHERE id=$3`,
      [platformPostId ?? null, publishedAt, publishJobId],
    );

    this.logger.log(`Published ${req.platform} post ${platformPostId} for tenant ${req.tenantId}`);
    return { status: 'published', platformPostId, publishedAt };
  }

  // ── Instagram Publishing (user's own token) ───────────────────────────────

  private async publishInstagram(
    creds: { primaryToken: string | null; accountId: string | null },
    req: OrganicPublishRequest,
  ): Promise<string> {
    const token     = creds.primaryToken!;
    const igAcctId  = creds.accountId!;
    const caption   = `${req.caption}\n\n${req.hashtags.map(h => `#${h}`).join(' ')}`;

    const videoUrl = await this.resolveVideoUrl(req);
    if (!videoUrl) throw new Error('No video URL available for Instagram publish');

    // Step 1: Create reel container
    const containerRes = await fetch(
      `https://graph.facebook.com/v21.0/${igAcctId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type:    'REELS',
        video_url:     videoUrl,
        caption,
        share_to_feed: true,
        access_token:  token,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const container: any = await containerRes.json();
    if (!containerRes.ok || !container.id) {
      throw new Error(`Instagram container creation failed: ${JSON.stringify(container)}`);
    }

    // Step 2: Poll for processing
    await this.pollInstagramProcessing(container.id, token);

    // Step 3: Publish
    const publishRes = await fetch(
      `https://graph.facebook.com/v21.0/${igAcctId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id, access_token: token }),
      signal: AbortSignal.timeout(15_000),
    });

    const published: any = await publishRes.json();
    if (!publishRes.ok || !published.id) {
      throw new Error(`Instagram publish failed: ${JSON.stringify(published)}`);
    }

    return published.id;
  }

  private async pollInstagramProcessing(containerId: string, token: string): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${containerId}?fields=status_code&access_token=${token}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const data: any = await res.json();
      if (data.status_code === 'FINISHED') return;
      if (data.status_code === 'ERROR') throw new Error(`Instagram processing error: ${JSON.stringify(data)}`);
    }
    throw new Error('Instagram video processing timed out');
  }

  // ── Facebook Publishing (user's own page token) ───────────────────────────

  private async publishFacebook(
    creds: { primaryToken: string | null; accountId: string | null },
    req: OrganicPublishRequest,
  ): Promise<string> {
    const token  = creds.primaryToken!;
    const pageId = creds.accountId!;
    const caption = `${req.caption}\n\n${req.hashtags.map(h => `#${h}`).join(' ')}`;

    const videoUrl = await this.resolveVideoUrl(req);
    if (!videoUrl) throw new Error('No video URL for Facebook publish');

    const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_url:     videoUrl,
        description:  caption,
        access_token: token,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data: any = await res.json();
    if (!res.ok || !data.id) {
      throw new Error(`Facebook publish failed: ${JSON.stringify(data)}`);
    }
    return data.id;
  }

  // ── TikTok Publishing (user's own API key) ────────────────────────────────

  private async publishTikTok(
    creds: { primaryToken: string | null; accountId: string | null },
    req: OrganicPublishRequest,
  ): Promise<string> {
    const accessToken = creds.primaryToken!;
    const videoUrl    = await this.resolveVideoUrl(req);
    if (!videoUrl) throw new Error('No video URL for TikTok publish');

    // TikTok Content Posting API v2
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title:              req.caption.slice(0, 150),
          privacy_level:      'PUBLIC_TO_EVERYONE',
          disable_duet:       false,
          disable_comment:    false,
          disable_stitch:     false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source:    'PULL_FROM_URL',
          video_url: videoUrl,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const initData: any = await initRes.json();
    if (!initRes.ok || initData.error?.code !== 'ok') {
      throw new Error(`TikTok init failed: ${JSON.stringify(initData)}`);
    }

    return initData.data?.publish_id ?? 'tiktok_pending';
  }

  // ── YouTube Shorts Publishing ─────────────────────────────────────────────

  private async publishYouTubeShorts(
    creds: { primaryToken: string | null; accountId: string | null },
    req: OrganicPublishRequest,
  ): Promise<string> {
    const accessToken = creds.primaryToken!;
    const videoUrl    = await this.resolveVideoUrl(req);
    if (!videoUrl) throw new Error('No video URL for YouTube');

    // Download video buffer
    const vidRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
    if (!vidRes.ok) throw new Error('Failed to fetch video for YouTube upload');
    const videoBuffer = Buffer.from(await vidRes.arrayBuffer());

    // Step 1: Insert video metadata
    const metaRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(videoBuffer.length),
      },
      body: JSON.stringify({
        snippet: {
          title:       req.caption.slice(0, 100),
          description: `${req.caption}\n\n${req.hashtags.map(h => `#${h}`).join(' ')}`,
          tags:        req.hashtags.slice(0, 15),
          categoryId:  '22', // People & Blogs
        },
        status: {
          privacyStatus:           'public',
          selfDeclaredMadeForKids: false,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!metaRes.ok) throw new Error(`YouTube resumable upload init failed: ${metaRes.status}`);
    const uploadUrl = metaRes.headers.get('Location');
    if (!uploadUrl) throw new Error('YouTube did not return upload URL');

    // Step 2: Upload video bytes
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'video/mp4',
      },
      body: videoBuffer,
      signal: AbortSignal.timeout(300_000),
    });

    const uploadData: any = await uploadRes.json();
    if (!uploadRes.ok || !uploadData.id) {
      throw new Error(`YouTube upload failed: ${JSON.stringify(uploadData)}`);
    }

    return uploadData.id;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async resolveVideoUrl(req: OrganicPublishRequest): Promise<string | null> {
    if (req.videoUrl) return req.videoUrl;

    if (req.videoJobId) {
      const result = await this.db.query(
        `SELECT a.metadata->>'cdnUrl' AS cdn_url, a.telegram_file_id
         FROM video_pipeline_jobs j
         LEFT JOIN telegram_storage_assets a ON a.id = j.telegram_asset_id
         WHERE j.id = $1 AND j.tenant_id = $2`,
        [req.videoJobId, req.tenantId],
      );
      return result.rows[0]?.cdn_url ?? null;
    }

    return null;
  }

  // ── Sync engagement stats ─────────────────────────────────────────────────

  async syncEngagementStats(tenantId: string, publishJobId: string): Promise<void> {
    const job = await this.db.query(
      `SELECT platform, platform_post_id, connection_id
       FROM organic_publish_jobs
       WHERE id = $1 AND tenant_id = $2 AND status = 'published'`,
      [publishJobId, tenantId],
    );
    if (job.rows.length === 0) return;

    const { platform, platform_post_id: postId } = job.rows[0];

    let stats: { views?: number; likes?: number; comments?: number; shares?: number; saves?: number } = {};

    try {
      if (platform === 'instagram' || platform === 'facebook') {
        const creds = await this.bizConnections.decryptForRuntime(
          tenantId,
          platform === 'instagram' ? 'meta_instagram' : 'meta_facebook_page',
        );
        const res = await fetch(
          `https://graph.facebook.com/v21.0/${postId}?fields=like_count,comments_count,shares,saved&access_token=${creds.primaryToken}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (res.ok) {
          const data: any = await res.json();
          stats = {
            likes:    data.like_count,
            comments: data.comments_count,
            shares:   data.shares?.count,
            saves:    data.saved,
          };
        }
      }
    } catch (err) {
      this.logger.warn(`Engagement sync failed for job ${publishJobId}: ${(err as Error).message}`);
      return;
    }

    await this.db.query(
      `UPDATE organic_publish_jobs
       SET likes=$1, comments=$2, shares=$3, saves=$4,
           last_stats_sync=NOW(), updated_at=NOW()
       WHERE id=$5`,
      [stats.likes??0, stats.comments??0, stats.shares??0, stats.saves??0, publishJobId],
    );
  }

  // ── List organic posts ────────────────────────────────────────────────────

  async listPublishJobs(tenantId: string, limit = 20): Promise<any[]> {
    const result = await this.db.query(
      `SELECT id, platform, status, caption, hashtags,
              scheduled_at, published_at, platform_post_id,
              views, likes, comments, shares, saves, organic_conversions,
              error_message, created_at
       FROM organic_publish_jobs
       WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows;
  }
}
