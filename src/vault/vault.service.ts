/**
 * VaultService — V59 Encrypted Credential Vault
 *
 * Stores all third-party API credentials (Meta tokens, Shopify tokens,
 * AI generation keys, social media credentials) with AES-256-GCM encryption.
 *
 * Security model:
 *   - Master encryption key lives ONLY in process env (VAULT_MASTER_KEY)
 *   - Each credential gets its own random IV + auth tag
 *   - Decryption happens only at execution time (not on reads/lists)
 *   - All access is audit-logged with actor, action, timestamp
 *   - Key rotation: re-encrypt with new key, keep old ciphertext until rotated
 *
 * Schema: vault_credentials
 *   id UUID PK
 *   tenant_id UUID NOT NULL
 *   key_name VARCHAR (e.g. 'META_ACCESS_TOKEN', 'SHOPIFY_API_KEY')
 *   provider VARCHAR (meta|shopify|openai|tiktok|google)
 *   ciphertext TEXT (base64 AES-256-GCM encrypted)
 *   iv TEXT (base64 random IV per credential)
 *   auth_tag TEXT (base64 GCM auth tag)
 *   key_version INT DEFAULT 1 (for rotation tracking)
 *   expires_at TIMESTAMPTZ NULL
 *   rotated_at TIMESTAMPTZ NULL
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 *   updated_at TIMESTAMPTZ DEFAULT NOW()
 */

import {
  Injectable,
  Logger,
  Inject,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import { DB_POOL } from '../common/database/database.module';
import { AuditService } from '../audit/audit.service';

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12;  // 96-bit IV (recommended for GCM)
const TAG_LEN = 16; // 128-bit auth tag

export type VaultProvider = 'meta' | 'shopify' | 'openai' | 'tiktok' | 'google' | 'telegram' | 'sendgrid' | 'other';

export interface CredentialRecord {
  id: string;
  tenantId: string;
  keyName: string;
  provider: VaultProvider;
  keyVersion: number;
  expiresAt: Date | null;
  rotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // plaintext is NEVER returned by list/get — only from decrypt()
}

@Injectable()
export class VaultService {
  private readonly logger = new Logger(VaultService.name);
  private readonly masterKey: Buffer;
  private readonly keyVersion: number;

  constructor(
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const keyHex = this.config.getOrThrow<string>('VAULT_MASTER_KEY');
    if (keyHex.length < 64) {
      throw new Error('VAULT_MASTER_KEY must be at least 64 hex chars (256-bit key)');
    }
    this.masterKey = Buffer.from(keyHex.slice(0, 64), 'hex');
    this.keyVersion = this.config.get<number>('VAULT_KEY_VERSION', 1);
  }

  // ── Store a credential ─────────────────────────────────────────────────────

  async store(
    tenantId: string,
    keyName: string,
    provider: VaultProvider,
    plaintext: string,
    expiresAt?: Date,
    actorId?: string,
  ): Promise<CredentialRecord> {
    if (!plaintext || plaintext.length < 4) {
      throw new BadRequestException('Credential value too short');
    }

    const { ciphertext, iv, authTag } = this.encrypt(plaintext);

    const res = await this.db.query<any>(
      `INSERT INTO vault_credentials
         (tenant_id, key_name, provider, ciphertext, iv, auth_tag, key_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, key_name)
       DO UPDATE SET
         ciphertext   = EXCLUDED.ciphertext,
         iv           = EXCLUDED.iv,
         auth_tag     = EXCLUDED.auth_tag,
         key_version  = EXCLUDED.key_version,
         expires_at   = EXCLUDED.expires_at,
         updated_at   = NOW()
       RETURNING id, tenant_id, key_name, provider, key_version, expires_at, rotated_at, created_at, updated_at`,
      [tenantId, keyName, provider, ciphertext, iv, authTag, this.keyVersion, expiresAt ?? null],
    );

    await this.audit.log({
      tenantId,
      actorId: actorId ?? 'system',
      action: 'VAULT_STORE',
      resource: 'vault_credentials',
      resourceId: keyName,
      details: { provider, keyVersion: this.keyVersion },
    });

    this.logger.log(`Vault: stored credential ${keyName} for tenant ${tenantId}`);
    return this.mapRow(res.rows[0]);
  }

  // ── Decrypt a credential (only during execution) ───────────────────────────

  async decrypt(
    tenantId: string,
    keyName: string,
    actorId?: string,
  ): Promise<string> {
    const res = await this.db.query<any>(
      `SELECT ciphertext, iv, auth_tag, key_version, expires_at
       FROM vault_credentials
       WHERE tenant_id = $1 AND key_name = $2 LIMIT 1`,
      [tenantId, keyName],
    );

    const row = res.rows[0];
    if (!row) {
      throw new ForbiddenException(`Credential ${keyName} not found for tenant`);
    }

    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await this.audit.log({
        tenantId,
        actorId: actorId ?? 'system',
        action: 'VAULT_DECRYPT_EXPIRED',
        resource: 'vault_credentials',
        resourceId: keyName,
        severity: 'warn',
      });
      throw new ForbiddenException(`Credential ${keyName} has expired`);
    }

    await this.audit.log({
      tenantId,
      actorId: actorId ?? 'system',
      action: 'VAULT_DECRYPT',
      resource: 'vault_credentials',
      resourceId: keyName,
      details: { keyVersion: row.key_version },
    });

    return this.decryptValue(row.ciphertext, row.iv, row.auth_tag);
  }

  // ── List credentials (metadata only — no plaintext) ───────────────────────

  async list(tenantId: string): Promise<CredentialRecord[]> {
    const res = await this.db.query<any>(
      `SELECT id, tenant_id, key_name, provider, key_version, expires_at, rotated_at, created_at, updated_at
       FROM vault_credentials
       WHERE tenant_id = $1
       ORDER BY key_name`,
      [tenantId],
    );
    return res.rows.map(r => this.mapRow(r));
  }

  // ── Delete a credential ────────────────────────────────────────────────────

  async delete(tenantId: string, keyName: string, actorId?: string): Promise<void> {
    await this.db.query(
      'DELETE FROM vault_credentials WHERE tenant_id = $1 AND key_name = $2',
      [tenantId, keyName],
    );
    await this.audit.log({
      tenantId,
      actorId: actorId ?? 'system',
      action: 'VAULT_DELETE',
      resource: 'vault_credentials',
      resourceId: keyName,
      severity: 'warn',
    });
  }

  // ── Rotate master key ──────────────────────────────────────────────────────
  // Call this when rotating VAULT_MASTER_KEY. Decrypts with old key, re-encrypts
  // with new key for all credentials across all tenants.

  async rotateMasterKey(
    oldKeyHex: string,
    newKeyHex: string,
    adminId: string,
  ): Promise<{ rotated: number; failed: number }> {
    const oldKey = Buffer.from(oldKeyHex.slice(0, 64), 'hex');
    const newKey = Buffer.from(newKeyHex.slice(0, 64), 'hex');
    const newVersion = this.keyVersion + 1;

    this.logger.warn(`Vault key rotation started by admin ${adminId}`);

    const allCreds = await this.db.query<any>(
      'SELECT id, tenant_id, key_name, ciphertext, iv, auth_tag FROM vault_credentials',
    );

    let rotated = 0;
    let failed = 0;

    for (const row of allCreds.rows) {
      try {
        const plain = this.decryptWithKey(oldKey, row.ciphertext, row.iv, row.auth_tag);
        const { ciphertext, iv, authTag } = this.encryptWithKey(newKey, plain);
        await this.db.query(
          `UPDATE vault_credentials
           SET ciphertext = $1, iv = $2, auth_tag = $3, key_version = $4, rotated_at = NOW()
           WHERE id = $5`,
          [ciphertext, iv, authTag, newVersion, row.id],
        );
        rotated++;
      } catch {
        this.logger.error(`Rotation failed for credential ${row.id}`);
        failed++;
      }
    }

    await this.audit.log({
      tenantId: '__system__',
      actorId: adminId,
      action: 'VAULT_KEY_ROTATION',
      resource: 'vault_credentials',
      resourceId: 'ALL',
      details: { rotated, failed, newVersion },
      severity: 'critical',
    });

    this.logger.warn(`Vault rotation complete: ${rotated} rotated, ${failed} failed`);
    return { rotated, failed };
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────

  private encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
    return this.encryptWithKey(this.masterKey, plaintext);
  }

  private encryptWithKey(
    key: Buffer,
    plaintext: string,
  ): { ciphertext: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  private decryptValue(ciphertext: string, iv: string, authTag: string): string {
    return this.decryptWithKey(this.masterKey, ciphertext, iv, authTag);
  }

  private decryptWithKey(
    key: Buffer,
    ciphertext: string,
    iv: string,
    authTag: string,
  ): string {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  private mapRow(row: any): CredentialRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      keyName: row.key_name,
      provider: row.provider,
      keyVersion: row.key_version,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      rotatedAt: row.rotated_at ? new Date(row.rotated_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
