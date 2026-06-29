import { Injectable, Logger }   from '@nestjs/common';
import axios                     from 'axios';
import { IPlatformAdapter, PostPayload, PostResult, PostAnalytics } from './platform.interface';

const YT_BASE   = 'https://www.googleapis.com/youtube/v3';
const YT_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';

@Injectable()
export class YouTubeShortsAdapter implements IPlatformAdapter {
  readonly platform = 'youtube_shorts' as const;
  private readonly logger = new Logger(YouTubeShortsAdapter.name);

  async post(payload: PostPayload, accessToken: string): Promise<PostResult> {
    try {
      const metaResp = await axios.post(
        `${YT_UPLOAD}?uploadType=resumable&part=snippet,status`,
        {
          snippet: { title: payload.caption.slice(0, 100), description: payload.caption, tags: payload.hashtags ?? [], categoryId: '26' },
          status:  { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/*' } },
      );

      const uploadUrl = String((metaResp as unknown as {headers:Record<string,unknown>}).headers['location'] ?? '');
      if (!uploadUrl) throw new Error('No upload URL from YouTube');

      const videoStream = await axios.get(payload.videoUrl, { responseType: 'stream' });
      const finalResp   = await axios.put(uploadUrl, (videoStream as unknown as {data: unknown}).data, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'video/mp4' },
      });

      const videoId = String((finalResp as unknown as {data: Record<string,unknown>}).data?.['id'] ?? '');
      this.logger.log(`[YouTube] Short posted: ${videoId}`);
      return { platform: 'youtube_shorts', postId: videoId, url: `https://youtube.com/shorts/${videoId}`, status: 'published', publishedAt: new Date() };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`[YouTube] Post failed: ${msg}`);
      return { platform: 'youtube_shorts', postId: '', url: '', status: 'failed', error: msg, publishedAt: new Date() };
    }
  }

  async getAnalytics(videoId: string, accessToken: string): Promise<PostAnalytics> {
    try {
      const resp = await axios.get(`${YT_BASE}/videos`, { params: { id: videoId, part: 'statistics' }, headers: { Authorization: `Bearer ${accessToken}` } });
      const stats = ((((resp as unknown as {data: Record<string, unknown[]>}).data?.['items']?.[0] as Record<string, Record<string,string>>) ?? {}).statistics) ?? {};
      return { postId: videoId, platform: 'youtube_shorts', views: parseInt(stats['viewCount'] ?? '0'), likes: parseInt(stats['likeCount'] ?? '0'), shares: 0, comments: parseInt(stats['commentCount'] ?? '0'), reach: parseInt(stats['viewCount'] ?? '0'), engagementRate: 0, fetchedAt: new Date() };
    } catch {
      return { postId: videoId, platform: 'youtube_shorts', views: 0, likes: 0, shares: 0, comments: 0, reach: 0, engagementRate: 0, fetchedAt: new Date() };
    }
  }

  async schedulePost(_payload: PostPayload, _accessToken: string, scheduleAt: Date): Promise<PostResult> {
    return { platform: 'youtube_shorts', postId: '', url: '', status: 'scheduled', publishedAt: scheduleAt };
  }
}
