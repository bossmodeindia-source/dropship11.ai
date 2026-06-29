import { Injectable, Logger }   from '@nestjs/common';
import axios                     from 'axios';
import { IPlatformAdapter, PostPayload, PostResult, PostAnalytics } from './platform.interface';

const TIKTOK_BASE = 'https://open.tiktokapis.com/v2';

@Injectable()
export class TikTokAdapter implements IPlatformAdapter {
  readonly platform = 'tiktok' as const;
  private readonly logger = new Logger(TikTokAdapter.name);

  async post(payload: PostPayload, accessToken: string): Promise<PostResult> {
    try {
      const resp = await axios.post(
        `${TIKTOK_BASE}/post/publish/video/init/`,
        {
          post_info: {
            title:         payload.caption.slice(0, 150),
            privacy_level: 'PUBLIC_TO_EVERYONE',
            disable_duet:  false,
            disable_stitch: false,
            video_cover_timestamp_ms: 1000,
          },
          source_info: {
            source:     'PULL_FROM_URL',
            video_url:  payload.videoUrl,
            chunk_size: 10_000_000,
            total_chunk_count: 1,
          },
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      );

      const publishId = String((resp as unknown as {data: {data: {publish_id: string}}}).data?.data?.publish_id ?? '');
      this.logger.log(`[TikTok] Post initiated: ${publishId}`);
      return { platform: 'tiktok', postId: publishId, url: `https://www.tiktok.com/@me/video/${publishId}`, status: 'published', publishedAt: new Date() };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`[TikTok] Post failed: ${msg}`);
      return { platform: 'tiktok', postId: '', url: '', status: 'failed', error: msg, publishedAt: new Date() };
    }
  }

  async getAnalytics(postId: string, accessToken: string): Promise<PostAnalytics> {
    try {
      const resp = await axios.post(
        `${TIKTOK_BASE}/video/query/`,
        { filters: { video_ids: [postId] }, fields: ['view_count','like_count','share_count','comment_count','reach','engagement_rate'] },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
      );
      const video = ((((resp as unknown as {data: {data: {videos: Record<string,number>[]}}}).data?.data?.videos?.[0]) as Record<string,number>)) ?? {};
      return { postId, platform: 'tiktok', views: video['view_count'] ?? 0, likes: video['like_count'] ?? 0, shares: video['share_count'] ?? 0, comments: video['comment_count'] ?? 0, reach: video['reach'] ?? 0, engagementRate: video['engagement_rate'] ?? 0, fetchedAt: new Date() };
    } catch {
      return { postId, platform: 'tiktok', views: 0, likes: 0, shares: 0, comments: 0, reach: 0, engagementRate: 0, fetchedAt: new Date() };
    }
  }

  async schedulePost(payload: PostPayload, accessToken: string, scheduleAt: Date): Promise<PostResult> {
    const resp = await axios.post(
      `${TIKTOK_BASE}/post/publish/video/init/`,
      {
        post_info: { title: payload.caption.slice(0, 150), privacy_level: 'PUBLIC_TO_EVERYONE', auto_add_music: true, scheduled_publish_time: Math.round(scheduleAt.getTime() / 1000) },
        source_info: { source: 'PULL_FROM_URL', video_url: payload.videoUrl, chunk_size: 10_000_000, total_chunk_count: 1 },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
    const publishId = String((resp as unknown as {data: {data: {publish_id: string}}}).data?.data?.publish_id ?? '');
    return { platform: 'tiktok', postId: publishId, url: '', status: 'scheduled', publishedAt: scheduleAt };
  }
}
