/**
 * Organic Platform Interface
 *
 * All organic posting platforms (Instagram, Facebook) implement this contract.
 * The service handles scheduling, hashtag generation, and engagement sync.
 */

export interface OrganicPostPayload {
  caption:    string;
  hashtags:   string[];
  hook:       string;
  mediaUrls:  string[];
  videoScript?: Record<string, unknown>;
  scheduledAt?: Date;
}

export interface OrganicPostResult {
  externalPostId:  string;
  externalPostUrl: string;
  publishedAt:     Date;
  platform:        string;
}

export interface EngagementSnapshot {
  externalPostId: string;
  platform:       string;
  views:          number;
  likes:          number;
  comments:       number;
  shares:         number;
  saves:          number;
  reach:          number;
  engagementRate: number;
  clickThroughs:  number;
  fetchedAt:      Date;
}

export interface OrganicPlatformAdapter {
  readonly platform: string;
  readonly hasCredentials: boolean;

  post(payload: OrganicPostPayload): Promise<OrganicPostResult>;
  schedulePost(payload: OrganicPostPayload): Promise<OrganicPostResult>;
  fetchEngagement(externalPostId: string): Promise<EngagementSnapshot>;
  boostPost(externalPostId: string, budgetInr: number): Promise<{ campaignId: string }>;
}

// ── Aliases used by TikTok and YouTube adapters ───────────────────────────
export interface PostPayload {
  caption:    string;
  hashtags?:  string[];
  videoUrl:   string;
  imageUrl?:  string;
  scheduleAt?: Date;
}

export interface PostResult {
  platform:    string;
  postId:      string;
  url:         string;
  status:      'published' | 'scheduled' | 'failed';
  publishedAt: Date;
  error?:      string;
}

export interface PostAnalytics {
  postId:         string;
  platform:       string;
  views:          number;
  likes:          number;
  shares:         number;
  comments:       number;
  reach:          number;
  engagementRate: number;
  fetchedAt:      Date;
}

export interface IPlatformAdapter {
  readonly platform: string;
  post(payload: PostPayload, accessToken: string): Promise<PostResult>;
  getAnalytics(postId: string, accessToken: string): Promise<PostAnalytics>;
  schedulePost(payload: PostPayload, accessToken: string, scheduleAt: Date): Promise<PostResult>;
}
