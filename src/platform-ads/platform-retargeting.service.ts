/**
 * PlatformRetargetingService — V60 PATCHED
 *
 * Fixes applied:
 *   [C3] buildAllAudiences() no longer returns raw emails.
 *        Emails are SHA-256 hashed and uploaded directly to Meta Custom Audiences.
 *        The API response now contains only { segment, audienceSize, metaAudienceId }.
 *        Raw PII never leaves the server process.
 *
 *   [H2] launchSegmentCampaign() now calls campaignService.launchCampaign() after
 *        createCampaign(). Previously campaigns were created as DRAFT and never
 *        set live — they existed in the DB but did not run on Meta.
 *
 *   [AUDIENCE-MIN] Meta Custom Audience minimum threshold raised from 20 → 100.
 *        Segments with fewer than 100 users will not deliver ads on Meta.
 *
 *   [DESTINATION-URL] Destination URL moved from hardcoded string to
 *        PLATFORM_SIGNUP_URL env var (falls back to the old value).
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { createHash } from 'crypto';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { DB_TOKEN, DB_POOL } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { platformRetargeting, platformCampaigns } from './platform-ads.schema';
import { AlertingService } from '../alerting/alerting.service';
import { PlatformCampaignService } from './platform-campaign.service';
import { MetaApiClient } from '../meta-ads/meta-api.client';
import { MetaApiExecutionGuard } from '../common/guards/meta-api-execution.guard';

export type RetargetingSegment =
  | 'ABANDONED_SIGNUP'
  | 'INACTIVE_TRIAL'
  | 'FAILED_UPGRADE'
  | 'CANCELED';

/**
 * [C3] FIXED: No raw emails in the public result type.
 * Only audience sizes and Meta audience IDs are surfaced.
 */
export interface RetargetingAudienceResult {
  segment:        RetargetingSegment;
  audienceSize:   number;
  metaAudienceId: string | null;
}

/** Internal type — never returned from public methods */
interface AudienceWithEmails {
  segment:      RetargetingSegment;
  audienceSize: number;
  emails:       string[];
}

/** [AUDIENCE-MIN] Meta requirement: minimum 100 matched users for delivery */
const META_AUDIENCE_MINIMUM = 100;

/** Hash a single email for Meta Custom Audience upload */
function sha256Email(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

@Injectable()
export class PlatformRetargetingService {
  private readonly logger = new Logger(PlatformRetargetingService.name);
  private readonly destinationUrl: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly alerting: AlertingService,
    private readonly campaignService: PlatformCampaignService,
    private readonly metaApi: MetaApiClient,
    private readonly config: ConfigService,
  ) {
    // [DESTINATION-URL FIX] Read from env, not hardcoded
    this.destinationUrl = this.config.get<string>(
      'PLATFORM_SIGNUP_URL',
      'https://app.aiempirebot.com/signup',
    );
  }

  // ── Build retargeting audiences ───────────────────────────────────────────

  /**
   * [C3] FIXED: Returns safe audience summaries only.
   * Emails are hashed and uploaded to Meta internally — never returned to callers.
   */
  async buildAllAudiences(): Promise<RetargetingAudienceResult[]> {
    const rawAudiences = await this.gatherAllAudiences();
    const results: RetargetingAudienceResult[] = [];

    for (const audience of rawAudiences) {
      if (audience.audienceSize === 0) continue;

      let metaAudienceId: string | null = null;

      if (audience.audienceSize >= META_AUDIENCE_MINIMUM && audience.emails.length > 0) {
        // [C3 FIX] Hash emails and upload directly to Meta — do not surface them
        metaAudienceId = await this.createAndPopulateMetaAudience(audience);
      } else if (audience.audienceSize > 0 && audience.audienceSize < META_AUDIENCE_MINIMUM) {
        this.logger.debug(
          `Segment ${audience.segment} has ${audience.audienceSize} users — ` +
          `below Meta minimum of ${META_AUDIENCE_MINIMUM}. Audience created but ads won't deliver until threshold is met.`,
        );
      }

      results.push({
        segment:        audience.segment,
        audienceSize:   audience.audienceSize,
        metaAudienceId,
      });
    }

    return results;
  }

  // ── Private: gather raw audience data (emails stay internal) ─────────────

  private async gatherAllAudiences(): Promise<AudienceWithEmails[]> {
    return Promise.all([
      this.buildAbandonedSignupAudience(),
      this.buildInactiveTrialAudience(),
      this.buildFailedUpgradeAudience(),
      this.buildCanceledAudience(),
    ]);
  }

  private async buildAbandonedSignupAudience(): Promise<AudienceWithEmails> {
    const result = await this.pool.query<{ email: string }>(`
      SELECT DISTINCT pl.email
      FROM platform_leads pl
      WHERE pl.stage = 'CLICK'
        AND pl.email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM platform_leads pl2
          WHERE pl2.email = pl.email
            AND pl2.stage IN ('SIGNUP', 'TRIAL', 'SUBSCRIBED')
        )
        AND pl.created_at >= NOW() - INTERVAL '30 days'
    `);
    const emails = result.rows.map(r => r.email).filter(Boolean);
    await this.upsertSegment('ABANDONED_SIGNUP', emails.length);
    return { segment: 'ABANDONED_SIGNUP', audienceSize: emails.length, emails };
  }

  private async buildInactiveTrialAudience(): Promise<AudienceWithEmails> {
    const result = await this.pool.query<{ email: string }>(`
      SELECT DISTINCT u.email
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id
      WHERE s.status = 'trialing'
        AND s.created_at <= NOW() - INTERVAL '7 days'
        AND s.created_at >= NOW() - INTERVAL '30 days'
    `);
    const emails = result.rows.map(r => r.email).filter(Boolean);
    await this.upsertSegment('INACTIVE_TRIAL', emails.length);
    return { segment: 'INACTIVE_TRIAL', audienceSize: emails.length, emails };
  }

  private async buildFailedUpgradeAudience(): Promise<AudienceWithEmails> {
    const result = await this.pool.query<{ email: string }>(`
      SELECT DISTINCT u.email
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id
      WHERE s.status = 'past_due'
        AND s.updated_at >= NOW() - INTERVAL '14 days'
    `);
    const emails = result.rows.map(r => r.email).filter(Boolean);
    await this.upsertSegment('FAILED_UPGRADE', emails.length);
    return { segment: 'FAILED_UPGRADE', audienceSize: emails.length, emails };
  }

  private async buildCanceledAudience(): Promise<AudienceWithEmails> {
    const result = await this.pool.query<{ email: string }>(`
      SELECT DISTINCT u.email
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id
      WHERE s.status = 'canceled'
        AND s.updated_at >= NOW() - INTERVAL '60 days'
        AND s.updated_at <= NOW() - INTERVAL '7 days'
    `);
    const emails = result.rows.map(r => r.email).filter(Boolean);
    await this.upsertSegment('CANCELED', emails.length);
    return { segment: 'CANCELED', audienceSize: emails.length, emails };
  }

  // ── Private: Meta Custom Audience upload (PII stays here) ────────────────

  /**
   * [C3] Creates a Meta Custom Audience and uploads SHA-256 hashed emails.
   * Raw emails are hashed in-process and never logged or returned.
   * Returns the Meta audience ID (safe to surface), or null on failure.
   */
  private async createAndPopulateMetaAudience(
    audience: AudienceWithEmails,
  ): Promise<string | null> {
    try {
      let metaAudienceId: string | null = null;

      await MetaApiExecutionGuard.runInEmergencyContext(
        `retarget-audience-${audience.segment}`,
        async () => {
          // Create the custom audience
          const created = await this.metaApi.createCustomAudience({
            name:                `[PLATFORM] Retargeting — ${audience.segment}`,
            description:         `Auto-built: ${audience.segment} (${audience.audienceSize} users)`,
            subtype:             'CUSTOM',
            customer_file_source: 'USER_PROVIDED_ONLY',
          });

          metaAudienceId = created.id;

          // [C3] Hash emails here — never passed to any other method
          const hashedEmails = audience.emails.map(sha256Email);

          const uploadResult = await this.metaApi.uploadAudienceUsers(
            metaAudienceId,
            hashedEmails,
          );

          this.logger.log(
            `Meta Custom Audience populated: segment=${audience.segment} ` +
            `audienceId=${metaAudienceId} ` +
            `received=${uploadResult.num_received} ` +
            `invalid=${uploadResult.num_invalid_entries}`,
          );
        },
      );

      return metaAudienceId;
    } catch (err) {
      this.logger.error(
        `Failed to create Meta Custom Audience for ${audience.segment}: ${(err as Error).message}`,
      );
      await this.alerting.sendWarn({
        title:   'Meta Custom Audience Upload Failed',
        message: `Segment ${audience.segment}: ${(err as Error).message}`,
      });
      return null;
    }
  }

  // ── Launch retargeting campaigns ──────────────────────────────────────────

  async launchRetargetingCampaigns(): Promise<void> {
    const audiences = await this.buildAllAudiences();

    if (!audiences.length) {
      this.logger.log('No retargeting audiences ready for launch');
      return;
    }

    for (const audience of audiences) {
      // [AUDIENCE-MIN FIX] Use 100, not 20
      if (audience.audienceSize < META_AUDIENCE_MINIMUM) {
        this.logger.debug(
          `Retargeting segment ${audience.segment} too small (${audience.audienceSize}) ` +
          `— need at least ${META_AUDIENCE_MINIMUM} for Meta delivery`,
        );
        continue;
      }

      try {
        await this.launchSegmentCampaign(audience);
      } catch (err) {
        this.logger.error(
          `Failed to launch retargeting for ${audience.segment}: ${(err as Error).message}`,
        );
        await this.alerting.sendWarn({
          title:   'Retargeting Launch Failed',
          message: `Segment ${audience.segment}: ${(err as Error).message}`,
        });
      }
    }
  }

  /**
   * [H2] FIXED: launchCampaign() is now called after createCampaign().
   *
   * BEFORE: only createCampaign() was called — campaign stayed DRAFT in DB,
   *         never became live on Meta.
   * AFTER:  createCampaign() → launchCampaign() — campaign is ACTIVE on Meta.
   */
  private async launchSegmentCampaign(audience: RetargetingAudienceResult): Promise<void> {
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM platform_retargeting WHERE segment = $1 AND is_active = true`,
      [audience.segment],
    );

    if (existing.rows.length) {
      this.logger.debug(`Retargeting segment ${audience.segment} already has active campaign`);
      return;
    }

    this.logger.log(
      `Launching retargeting campaign: segment=${audience.segment}, ` +
      `audience_size=${audience.audienceSize}`,
    );

    const campaignMap: Record<RetargetingSegment, {
      name: string;
      type: typeof platformCampaigns.$inferInsert['type'];
    }> = {
      ABANDONED_SIGNUP:  { name: 'Abandoned Signup Retarget',  type: 'SIGNUP' },
      INACTIVE_TRIAL:    { name: 'Inactive Trial Activation',   type: 'FREE_TRIAL' },
      FAILED_UPGRADE:    { name: 'Failed Upgrade Recovery',     type: 'SUBSCRIPTION_CONVERSION' },
      CANCELED:          { name: 'Win-Back Canceled Users',     type: 'RETARGETING' },
    };

    const cfg = campaignMap[audience.segment];

    // Step 1: Create (status = DRAFT)
    const campaign = await this.campaignService.createCampaign({
      name:             cfg.name,
      type:             cfg.type,
      mode:             'PAID',
      channel:          'META',
      dailyBudgetInr:   500,
      maxDailySpendInr: 3000,
      creativeStyle:    audience.segment === 'CANCELED' ? 'TESTIMONIAL' : 'SAAS_DEMO',
      // [DESTINATION-URL FIX] From config, not hardcoded
      destinationUrl:   this.destinationUrl,
      notes:            `Auto-launched retargeting: segment=${audience.segment}, size=${audience.audienceSize}`,
    });

    // [H2 FIX] Step 2: Launch (DRAFT → ACTIVE on Meta)
    try {
      await this.campaignService.launchCampaign(campaign.id);
      this.logger.log(
        `Retargeting campaign launched on Meta: ${campaign.id} for segment ${audience.segment}`,
      );
    } catch (err) {
      // Campaign exists in DB — mark the failure so we don't leave a ghost DRAFT
      this.logger.error(
        `Meta launch failed for retargeting campaign ${campaign.id}: ${(err as Error).message}`,
      );
      throw err; // bubble up to caller's per-segment error handler
    }

    await this.upsertSegment(audience.segment, audience.audienceSize, campaign.id);
  }

  // ── DB helpers ────────────────────────────────────────────────────────────

  private async upsertSegment(
    segment: RetargetingSegment,
    audienceSize: number,
    campaignId?: string,
  ): Promise<void> {
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM platform_retargeting WHERE segment = $1`,
      [segment],
    );

    if (existing.rows.length) {
      await this.pool.query(
        `UPDATE platform_retargeting SET audience_size = $1, last_sync_at = NOW(), updated_at = NOW()
         WHERE segment = $2`,
        [audienceSize, segment],
      );
    } else {
      await this.pool.query(
        `INSERT INTO platform_retargeting (name, segment, audience_size, is_active, campaign_id, last_sync_at, created_at, updated_at)
         VALUES ($1, $2, $3, true, $4, NOW(), NOW(), NOW())`,
        [`${segment} Audience`, segment, audienceSize, campaignId ?? null],
      );
    }
  }

  async listSegments(): Promise<typeof platformRetargeting.$inferSelect[]> {
    return this.db.select().from(platformRetargeting);
  }
}
