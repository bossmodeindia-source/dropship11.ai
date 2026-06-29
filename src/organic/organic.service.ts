/**
 * OrganicService
 *
 * Zero-rupee organic posting engine.
 *
 * Capabilities:
 *   - Auto-generate captions, hooks, hashtags from product data
 *   - Post immediately or schedule to Instagram / Facebook / Reels
 *   - Track engagement metrics per post
 *   - Hybrid escalation: if engagement_rate > threshold → trigger paid ads
 *   - A/B test hooks and captions using Thompson Sampling (via ThompsonService)
 */

import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as baseSchema from '../common/database/schema';
import * as ext from '../commerce/schema-extensions';
import { InstagramPlatformAdapter } from './platforms/instagram.adapter';
import { FacebookPlatformAdapter } from './platforms/facebook.adapter';
import { HashtagGeneratorService } from './hashtag-generator.service';
import { CreativeGeneratorService } from '../ad-creatives/creative-generator.service';
import { CreateOrganicPostDto } from './dto/organic.dto';

export type Platform = 'instagram' | 'facebook' | 'instagram_reels' | 'facebook_reels';

@Injectable()
export class OrganicService {
  private readonly logger = new Logger(OrganicService.name);

  /** Engagement rate above this triggers hybrid escalation to paid ads */
  private readonly HYBRID_ESCALATION_THRESHOLD = 0.03; // 3%

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly instagram:  InstagramPlatformAdapter,
    private readonly facebook:   FacebookPlatformAdapter,
    private readonly hashtags:   HashtagGeneratorService,
    private readonly creatives:  CreativeGeneratorService,
  ) {}

  // ── Post Now ──────────────────────────────────────────────────────────────

  /**
   * POST /organic/post
   * Immediately publish to one or more platforms.
   */
  async post(userId: string, dto: CreateOrganicPostDto) {
    const product = await this.resolveProduct(userId, dto.productId);
    const bundle  = await this.buildPostBundle(product, dto);

    const results = await Promise.allSettled(
      dto.platforms.map(platform => this.dispatchToAdapter(platform, bundle, false)),
    );

    const saved = await Promise.allSettled(
      results.map(async (result, i) => {
        const platform = dto.platforms[i];
        if (result.status === 'fulfilled') {
          return this.savePost(userId, product.id, dto.campaignId, platform, bundle, result.value, 'published');
        } else {
          return this.savePost(userId, product.id, dto.campaignId, platform, bundle, null, 'failed', result.reason?.message);
        }
      }),
    );

    return {
      posted: saved.filter((r): r is PromiseFulfilledResult<typeof r extends PromiseFulfilledResult<infer T> ? T : never> => r.status === 'fulfilled').map(r => r.value),
      failed: saved.filter(r => r.status === 'rejected').length,
    };
  }

  // ── Schedule ─────────────────────────────────────────────────────────────

  /**
   * POST /organic/schedule
   * Schedule a post for a future time.
   */
  async schedulePost(userId: string, dto: CreateOrganicPostDto & { scheduledAt: Date }) {
    const product = await this.resolveProduct(userId, dto.productId);
    const bundle  = await this.buildPostBundle(product, { ...dto, scheduledAt: dto.scheduledAt });

    const saved = await Promise.allSettled(
      dto.platforms.map(platform =>
        this.savePost(userId, product.id, dto.campaignId, platform, bundle, null, 'scheduled'),
      ),
    );

    this.logger.log(`Scheduled ${saved.length} posts for product ${product.id}`);
    return { scheduled: saved.filter(r => r.status === 'fulfilled').length };
  }

  // ── Cron: publish scheduled posts ─────────────────────────────────────────

  async publishDueScheduledPosts(): Promise<void> {
    const due = await this.db
      .select()
      .from(ext.organicPosts)
      .where(
        and(
          eq(ext.organicPosts.status, 'scheduled'),
        ),
      );

    const now = Date.now();
    const ready = due.filter((p: any) =>
      p.scheduledAt && new Date(p.scheduledAt).getTime() <= now,
    );

    this.logger.log(`Publishing ${ready.length} scheduled organic posts`);

    for (const post of ready) {
      await this.publishStoredPost(post);
    }
  }

  // ── Engagement Sync ───────────────────────────────────────────────────────

  /**
   * Fetch and store engagement metrics for a post.
   * Called by cron every 6 hours after publication.
   */
  async syncEngagement(organicPostId: string): Promise<typeof ext.engagementMetrics.$inferSelect | null> {
    const [post] = await this.db
      .select()
      .from(ext.organicPosts)
      .where(eq(ext.organicPosts.id, organicPostId))
      .limit(1);

    if (!post || !post.externalPostId) return null;

    const adapter = post.platform.startsWith('instagram') ? this.instagram : this.facebook;
    const snap    = await adapter.fetchEngagement(post.externalPostId);

    const [saved] = await this.db
      .insert(ext.engagementMetrics)
      .values({
        organicPostId,
        platform:       post.platform,
        views:          snap.views,
        likes:          snap.likes,
        comments:       snap.comments,
        shares:         snap.shares,
        saves:          snap.saves,
        reach:          snap.reach,
        engagementRate: String(snap.engagementRate),
        clickThroughs:  snap.clickThroughs,
      })
      .returning();

    this.logger.debug(
      `Engagement synced for post ${organicPostId}: ER=${snap.engagementRate} views=${snap.views}`,
    );

    return saved;
  }

  /**
   * Sync all published posts that need engagement data refresh.
   * Called by cron.
   */
  async syncAllEngagement(): Promise<void> {
    const posts = await this.db
      .select()
      .from(ext.organicPosts)
      .where(eq(ext.organicPosts.status, 'published'));

    this.logger.log(`Syncing engagement for ${posts.length} organic posts`);
    for (const post of posts) {
      await this.syncEngagement(post.id).catch(err =>
        this.logger.error(`Engagement sync failed for ${post.id}: ${err.message}`),
      );
    }
  }

  // ── Hybrid Escalation Check ───────────────────────────────────────────────

  /**
   * Check if any organic posts for this product are performing well enough
   * to warrant paid ad escalation. Returns true if escalation should happen.
   */
  async shouldEscalateToPaid(productId: string): Promise<{
    shouldEscalate: boolean;
    bestPostId?:    string;
    bestER?:        number;
  }> {
    const posts = await this.db
      .select()
      .from(ext.organicPosts)
      .where(
        and(
          eq(ext.organicPosts.productId, productId),
          eq(ext.organicPosts.status, 'published'),
        ),
      );

    if (!posts.length) return { shouldEscalate: false };

    const metrics = await this.db
      .select()
      .from(ext.engagementMetrics)
      .where(
        eq(ext.engagementMetrics.organicPostId, posts[0].id),
      )
      .orderBy(desc(ext.engagementMetrics.fetchedAt))
      .limit(10);

    if (!metrics.length) return { shouldEscalate: false };

    const best = metrics.reduce((top: any, m: any) =>
      parseFloat(m.engagementRate) > parseFloat(top.engagementRate) ? m : top,
    );

    const er = parseFloat(best.engagementRate ?? '0');
    const post = best.organicPostId ? posts.find((p: any) => p.id === best.organicPostId) : undefined;

    return {
      shouldEscalate: er >= this.HYBRID_ESCALATION_THRESHOLD,
      bestPostId:     post?.id,
      bestER:         er,
    };
  }

  // ── Boost Post ────────────────────────────────────────────────────────────

  async boostPost(userId: string, organicPostId: string, budgetInr: number) {
    const [post] = await this.db
      .select()
      .from(ext.organicPosts)
      .where(
        and(
          eq(ext.organicPosts.id, organicPostId),
          eq(ext.organicPosts.userId, userId),
        ),
      )
      .limit(1);

    if (!post) throw new NotFoundException('Organic post not found');
    if (!post.externalPostId) throw new BadRequestException('Post has no external ID — cannot boost');

    const adapter = post.platform.startsWith('instagram') ? this.instagram : this.facebook;
    const { campaignId } = await adapter.boostPost(post.externalPostId, budgetInr);

    await this.db
      .update(ext.organicPosts)
      .set({ isBoosted: true, boostCampaignId: campaignId, updatedAt: new Date() })
      .where(eq(ext.organicPosts.id, organicPostId));

    return { boosted: true, campaignId };
  }

  // ── Read API ──────────────────────────────────────────────────────────────

  async listPosts(userId: string) {
    return this.db
      .select()
      .from(ext.organicPosts)
      .where(eq(ext.organicPosts.userId, userId))
      .orderBy(desc(ext.organicPosts.createdAt));
  }

  async getPostMetrics(userId: string, organicPostId: string) {
    const [post] = await this.db
      .select()
      .from(ext.organicPosts)
      .where(
        and(
          eq(ext.organicPosts.id, organicPostId),
          eq(ext.organicPosts.userId, userId),
        ),
      )
      .limit(1);

    if (!post) throw new NotFoundException('Organic post not found');

    const metrics = await this.db
      .select()
      .from(ext.engagementMetrics)
      .where(eq(ext.engagementMetrics.organicPostId, organicPostId))
      .orderBy(desc(ext.engagementMetrics.fetchedAt));

    return { post, metrics };
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private async resolveProduct(userId: string, productId: string) {
    const [product] = await this.db
      .select()
      .from(baseSchema.products)
      .where(
        and(
          eq(baseSchema.products.id,     productId),
          eq(baseSchema.products.userId, userId),
        ),
      )
      .limit(1);

    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async buildPostBundle(product: any, dto: Partial<CreateOrganicPostDto> & { scheduledAt?: Date }) {
    const hooks      = await this.creatives.generateHooks(product);
    const captions   = await this.creatives.generateAdCopy(product);
    const tagSet     = this.hashtags.generate({
      category: product.category,
      title:    product.title,
      tags:     product.tags,
    });
    const reelScript = this.hashtags.generateReelsScript({
      title:        product.title,
      description:  product.description,
      category:     product.category,
      sellingPrice: product.sellingPrice,
    });

    return {
      caption:     dto.caption || captions[0] || `Check out ${product.title}!`,
      hashtags:    dto.hashtags?.length ? dto.hashtags : tagSet.all,
      hook:        dto.hook || hooks[0] || this.hashtags.generateHooks(product)[0],
      mediaUrls:   dto.mediaUrls?.length ? dto.mediaUrls : product.imageUrls ?? [],
      videoScript: reelScript,
      scheduledAt: dto.scheduledAt,
    };
  }

  private async dispatchToAdapter(platform: string, bundle: any, schedule: boolean) {
    const isInstagram = platform.startsWith('instagram');
    const adapter     = isInstagram ? this.instagram : this.facebook;
    return schedule && bundle.scheduledAt
      ? adapter.schedulePost(bundle)
      : adapter.post(bundle);
  }

  private async savePost(
    userId:       string,
    productId:    string,
    campaignId:   string | undefined,
    platform:     string,
    bundle:       any,
    result:       any | null,
    status:       string,
    failureReason?: string,
  ) {
    const [saved] = await this.db
      .insert(ext.organicPosts)
      .values(({
        userId:          userId as string,
        productId:       productId as string,
        campaignId:      campaignId ?? null,
        platform,
        status,
        caption:         bundle.caption,
        hashtags:        bundle.hashtags,
        hook:            bundle.hook,
        mediaUrls:       bundle.mediaUrls,
        videoScript:     bundle.videoScript,
        externalPostId:  result?.externalPostId  ?? null,
        externalPostUrl: result?.externalPostUrl ?? null,
        scheduledAt:     bundle.scheduledAt ?? null,
        publishedAt:     result?.publishedAt ?? null,
        failureReason:   failureReason ?? null,
      }) as any)
      .returning();
    return saved;
  }

  private async publishStoredPost(post: any): Promise<void> {
    try {
      const adapter = post.platform.startsWith('instagram') ? this.instagram : this.facebook;
      const result  = await adapter.post({
        caption:  post.caption,
        hashtags: post.hashtags,
        hook:     post.hook,
        mediaUrls: post.mediaUrls,
        videoScript: post.videoScript,
      });

      await this.db
        .update(ext.organicPosts)
        .set({
          status:          'published',
          externalPostId:  result.externalPostId,
          externalPostUrl: result.externalPostUrl,
          publishedAt:     result.publishedAt,
          updatedAt:       new Date(),
        })
        .where(eq(ext.organicPosts.id, post.id));

      this.logger.log(`Published scheduled post ${post.id}`);
    } catch (err: any) {
      await this.db
        .update(ext.organicPosts)
        .set({ status: 'failed', failureReason: err.message, updatedAt: new Date() })
        .where(eq(ext.organicPosts.id, post.id));
      this.logger.error(`Failed to publish scheduled post ${post.id}: ${err.message}`);
    }
  }
}
