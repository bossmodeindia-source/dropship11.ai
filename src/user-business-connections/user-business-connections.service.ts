/**
 * UserBusinessConnectionsService
 *
 * Manages encrypted storage of user's business platform credentials:
 *  - Meta Ad Account tokens + Pixel IDs
 *  - Instagram / Facebook Page tokens
 *  - TikTok API keys
 *  - YouTube API keys
 *  - Shopify access tokens + webhook secrets
 *  - WhatsApp Business tokens
 *  - Telegram notification chat IDs
 *
 * SECURITY MODEL:
 *  - All credentials AES-256-GCM encrypted before storage
 *  - Decrypted values NEVER returned to frontend
 *  - Tenant-isolated (row-level check on every operation)
 *  - Key rotation supported via key_version field
 *  - Full audit log on every write
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import { DB_POOL } from '../common/database/database.module';
import { AuditService } from '../audit/audit.service';
import {
  ConnectBusinessAccountDto,
  SupportedPlatform,
} from './dto/user-business-connections.dto';

const ALGO   = 'aes-256-gcm';
const IV_LEN = 12;

export interface BusinessConnection {
  id:               string;
  tenantId:         string;
  platform:         SupportedPlatform;
  accountLabel:     string | null;
  connectionStatus: string;
  isActive:         boolean;
  scopesGranted:    string[];
  tokenExpiresAt:   Date | null;
  lastValidatedAt:  Date | null;
  createdAt:        Date;
  updatedAt:        Date;
  // NOTE: No token fields ever returned
}

@Injectable()
export class UserBusinessConnectionsService {
  private readonly logger = new Logger(UserBusinessConnectionsService.name);

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly audit: AuditService,
  ) {}

  // ── Connect a business account ────────────────────────────────────────────

  async connectAccount(
    tenantId: string,
    dto: ConnectBusinessAccountDto,
  ): Promise<BusinessConnection> {
    // Validate the token with the platform
    await this.validatePlatformCredentials(dto.platform, dto.primaryToken, dto.accountId);

    const encPrimary = dto.primaryToken ? this.encrypt(dto.primaryToken) : null;
    const encSecondary = dto.secondaryToken ? this.encrypt(dto.secondaryToken) : null;
    const encAccountId = dto.accountId ? this.encrypt(dto.accountId) : null;
    const encPixelId   = dto.pixelId   ? this.encrypt(dto.pixelId)   : null;

    const result = await this.db.query(
      `INSERT INTO user_business_connections (
         tenant_id, platform, account_label,
         encrypted_primary_token, primary_iv, primary_auth_tag,
         encrypted_secondary_token, secondary_iv, secondary_auth_tag,
         encrypted_account_id, account_id_iv, account_id_auth_tag,
         encrypted_pixel_id, pixel_iv, pixel_auth_tag,
         connection_status, is_active, scopes_granted,
         token_expires_at, last_validated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               'active',true,$16,$17,NOW())
       ON CONFLICT (tenant_id, platform) DO UPDATE SET
         encrypted_primary_token   = EXCLUDED.encrypted_primary_token,
         primary_iv                = EXCLUDED.primary_iv,
         primary_auth_tag          = EXCLUDED.primary_auth_tag,
         encrypted_secondary_token = EXCLUDED.encrypted_secondary_token,
         secondary_iv              = EXCLUDED.secondary_iv,
         secondary_auth_tag        = EXCLUDED.secondary_auth_tag,
         encrypted_account_id      = EXCLUDED.encrypted_account_id,
         account_id_iv             = EXCLUDED.account_id_iv,
         account_id_auth_tag       = EXCLUDED.account_id_auth_tag,
         encrypted_pixel_id        = EXCLUDED.encrypted_pixel_id,
         pixel_iv                  = EXCLUDED.pixel_iv,
         pixel_auth_tag            = EXCLUDED.pixel_auth_tag,
         account_label             = EXCLUDED.account_label,
         connection_status         = 'active',
         is_active                 = true,
         scopes_granted            = EXCLUDED.scopes_granted,
         token_expires_at          = EXCLUDED.token_expires_at,
         last_validated_at         = NOW(),
         key_version               = user_business_connections.key_version + 1,
         updated_at                = NOW()
       RETURNING *`,
      [
        tenantId, dto.platform, dto.accountLabel ?? null,
        encPrimary?.ciphertext ?? null, encPrimary?.iv ?? null, encPrimary?.authTag ?? null,
        encSecondary?.ciphertext ?? null, encSecondary?.iv ?? null, encSecondary?.authTag ?? null,
        encAccountId?.ciphertext ?? null, encAccountId?.iv ?? null, encAccountId?.authTag ?? null,
        encPixelId?.ciphertext ?? null, encPixelId?.iv ?? null, encPixelId?.authTag ?? null,
        JSON.stringify(dto.scopesGranted ?? []),
        dto.tokenExpiresAt ?? null,
      ],
    );

    this.audit.log({
      tenantId,
      actorId:  tenantId,
      action:   'business_connection.connected',
      resource: 'user_business_connections',
      resourceId: result.rows[0].id,
      details: { platform: dto.platform, accountLabel: dto.accountLabel },
    });

    this.logger.log(`Tenant ${tenantId} connected business account: ${dto.platform}`);
    return this.mapRow(result.rows[0]);
  }

  // ── List connections ──────────────────────────────────────────────────────

  async listConnections(tenantId: string): Promise<BusinessConnection[]> {
    const result = await this.db.query(
      `SELECT id, tenant_id, platform, account_label, connection_status,
              is_active, scopes_granted, token_expires_at, last_validated_at,
              created_at, updated_at
       FROM user_business_connections
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY platform, created_at DESC`,
      [tenantId],
    );
    return result.rows.map(r => this.mapRow(r));
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  async disconnectAccount(tenantId: string, connectionId: string): Promise<void> {
    const conn = await this.assertOwnership(tenantId, connectionId);
    await this.db.query(
      `UPDATE user_business_connections
       SET is_active = false, connection_status = 'disabled', updated_at = NOW()
       WHERE id = $1`,
      [connectionId],
    );
    this.audit.log({
      tenantId,
      actorId:  tenantId,
      action:   'business_connection.disconnected',
      resource: 'user_business_connections',
      resourceId: connectionId,
      details: { platform: conn.platform },
    });
  }

  // ── Decrypt for runtime use ───────────────────────────────────────────────
  // Called ONLY by services that need to make API calls (MetaAdsService, OrganicService, etc.)
  // Returns plaintext credentials for the duration of the call only.

  async decryptForRuntime(
    tenantId: string,
    platform: SupportedPlatform,
  ): Promise<{
    primaryToken: string | null;
    secondaryToken: string | null;
    accountId: string | null;
    pixelId: string | null;
  }> {
    const result = await this.db.query(
      `SELECT encrypted_primary_token, primary_iv, primary_auth_tag,
              encrypted_secondary_token, secondary_iv, secondary_auth_tag,
              encrypted_account_id, account_id_iv, account_id_auth_tag,
              encrypted_pixel_id, pixel_iv, pixel_auth_tag,
              connection_status, is_active
       FROM user_business_connections
       WHERE tenant_id = $1 AND platform = $2 AND is_active = true
       LIMIT 1`,
      [tenantId, platform],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException(
        `No active ${platform} connection. Connect your account in Settings → Business Accounts.`,
      );
    }

    const row = result.rows[0];

    return {
      primaryToken:   row.encrypted_primary_token
        ? this.decrypt(row.encrypted_primary_token, row.primary_iv, row.primary_auth_tag)
        : null,
      secondaryToken: row.encrypted_secondary_token
        ? this.decrypt(row.encrypted_secondary_token, row.secondary_iv, row.secondary_auth_tag)
        : null,
      accountId:      row.encrypted_account_id
        ? this.decrypt(row.encrypted_account_id, row.account_id_iv, row.account_id_auth_tag)
        : null,
      pixelId:        row.encrypted_pixel_id
        ? this.decrypt(row.encrypted_pixel_id, row.pixel_iv, row.pixel_auth_tag)
        : null,
    };
  }

  // ── Platform credential validation ────────────────────────────────────────

  private async validatePlatformCredentials(
    platform: SupportedPlatform,
    primaryToken: string | undefined,
    accountId: string | undefined,
  ): Promise<void> {
    if (!primaryToken) return;

    const validators: Partial<Record<SupportedPlatform, () => Promise<void>>> = {
      meta_ads: async () => {
        const res = await fetch(
          `https://graph.facebook.com/v21.0/me?access_token=${primaryToken}`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (res.status === 401) throw new Error('Invalid Meta access token');
      },
      shopify: async () => {
        if (!accountId) throw new Error('Shopify store domain is required');
        const domain = accountId.replace(/https?:\/\//, '').replace(/\/$/, '');
        const res = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
          headers: { 'X-Shopify-Access-Token': primaryToken },
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401) throw new Error('Invalid Shopify access token');
      },
    };

    const validator = validators[platform];
    if (validator) {
      try { await validator(); }
      catch (err) {
        throw new ConflictException(
          `${platform} credential validation failed: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────

  private getMasterKey(): Buffer {
    const key = process.env.ENCRYPTION_MASTER_KEY;
    if (!key || key.length < 64) throw new Error('ENCRYPTION_MASTER_KEY not set');
    return Buffer.from(key.slice(0, 64), 'hex');
  }

  private encrypt(plain: string): { ciphertext: string; iv: string; authTag: string } {
    const iv      = crypto.randomBytes(IV_LEN);
    const cipher  = crypto.createCipheriv(ALGO, this.getMasterKey(), iv);
    const enc     = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      ciphertext: enc.toString('base64'),
      iv:         iv.toString('base64'),
      authTag:    cipher.getAuthTag().toString('base64'),
    };
  }

  private decrypt(ct: string, iv: string, tag: string): string {
    const dc = crypto.createDecipheriv(ALGO, this.getMasterKey(), Buffer.from(iv, 'base64'));
    dc.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([dc.update(Buffer.from(ct, 'base64')), dc.final()]).toString('utf8');
  }

  private async assertOwnership(tenantId: string, id: string): Promise<any> {
    const r = await this.db.query(
      'SELECT * FROM user_business_connections WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    if (r.rows.length === 0) throw new NotFoundException('Connection not found');
    return r.rows[0];
  }

  private mapRow(row: any): BusinessConnection {
    return {
      id:               row.id,
      tenantId:         row.tenant_id,
      platform:         row.platform,
      accountLabel:     row.account_label,
      connectionStatus: row.connection_status,
      isActive:         row.is_active,
      scopesGranted:    Array.isArray(row.scopes_granted)
                          ? row.scopes_granted
                          : JSON.parse(row.scopes_granted ?? '[]'),
      tokenExpiresAt:   row.token_expires_at,
      lastValidatedAt:  row.last_validated_at,
      createdAt:        row.created_at,
      updatedAt:        row.updated_at,
    };
  }
}
