import {
  Injectable,
  Inject,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { SaveShopifyApiKeyDto } from './dto/save-api-key.dto';
import { EncryptionService } from '../common/crypto/encryption.service';

export interface ShopifyCredentials {
  id: string;
  userId: string;
  shopDomain: string;
  accessToken: string;      // ALWAYS plaintext at runtime — encrypted at rest
  webhookSecret: string | null; // ALWAYS plaintext at runtime — encrypted at rest
}

/**
 * SECURITY: accessToken and webhookSecret are encrypted with AES-256-GCM
 * before being written to the DB. They are decrypted at read time and
 * NEVER logged in plaintext form.
 */
@Injectable()
export class ShopifyApiKeysService {
  private readonly logger = new Logger(ShopifyApiKeysService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Upsert Shopify credentials for a user.
   * Tokens are AES-256-GCM encrypted before persisting.
   */
  async save(userId: string, dto: SaveShopifyApiKeyDto): Promise<ShopifyCredentials> {
    const encryptedToken  = this.encryption.encrypt(dto.accessToken);
    const encryptedSecret = dto.webhookSecret
      ? this.encryption.encrypt(dto.webhookSecret)
      : null;

    const existing = await this.db.query.shopifyApiKeys.findFirst({
      where: eq(schema.shopifyApiKeys.userId, userId),
    });

    if (existing) {
      const [updated] = await this.db
        .update(schema.shopifyApiKeys)
        .set({
          shopDomain:    dto.shopDomain.toLowerCase().trim(),
          accessToken:   encryptedToken,      // encrypted
          webhookSecret: encryptedSecret,     // encrypted
          updatedAt:     new Date(),
        })
        .where(eq(schema.shopifyApiKeys.userId, userId))
        .returning();

      // NEVER log accessToken — only domain is safe to log
      this.logger.log(`Updated Shopify credentials user=${userId} domain=${dto.shopDomain.toLowerCase().trim()}`);
      return this.decryptRow(updated as ShopifyCredentials);
    }

    const [created] = await this.db
      .insert(schema.shopifyApiKeys)
      .values({
        userId,
        shopDomain:    dto.shopDomain.toLowerCase().trim(),
        accessToken:   encryptedToken,        // encrypted
        webhookSecret: encryptedSecret,       // encrypted
      })
      .returning();

    this.logger.log(`Saved Shopify credentials user=${userId} domain=${dto.shopDomain.toLowerCase().trim()}`);
    return this.decryptRow(created as ShopifyCredentials);
  }

  /**
   * Fetch credentials for a user — throws if not configured.
   * Returns plaintext tokens.
   */
  async getForUser(userId: string): Promise<ShopifyCredentials> {
    const row = await this.db.query.shopifyApiKeys.findFirst({
      where: eq(schema.shopifyApiKeys.userId, userId),
    });

    if (!row) {
      throw new NotFoundException(
        'Shopify API credentials not configured. ' +
        'Call PUT /shopify/credentials to set them up.',
      );
    }

    return this.decryptRow(row as ShopifyCredentials);
  }

  /**
   * Look up credentials by shop domain (webhook verification).
   * Returns plaintext tokens.
   */
  async getByShopDomain(shopDomain: string): Promise<ShopifyCredentials | null> {
    const row = await this.db.query.shopifyApiKeys.findFirst({
      where: eq(schema.shopifyApiKeys.shopDomain, shopDomain.toLowerCase().trim()),
    });
    if (!row) return null;
    return this.decryptRow(row as ShopifyCredentials);
  }

  async delete(userId: string): Promise<void> {
    await this.db
      .delete(schema.shopifyApiKeys)
      .where(eq(schema.shopifyApiKeys.userId, userId));
    this.logger.log(`Deleted Shopify credentials user=${userId}`);
  }

  async get(userId: string): Promise<{ shopDomain: string; configured: boolean }> {
    const row = await this.db.query.shopifyApiKeys.findFirst({
      where: eq(schema.shopifyApiKeys.userId, userId),
      columns: { shopDomain: true },
    });
    return {
      shopDomain: row?.shopDomain ?? '',
      configured: !!row,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Decrypt DB row → runtime plaintext. Never log decrypted values. */
  private decryptRow(row: ShopifyCredentials): ShopifyCredentials {
    return {
      id:            row.id,
      userId:        row.userId,
      shopDomain:    row.shopDomain,
      accessToken:   this.encryption.decrypt(row.accessToken),
      webhookSecret: row.webhookSecret
        ? this.encryption.decrypt(row.webhookSecret)
        : null,
    };
  }

/** Alias used by shopify-order-sync — returns full credentials */
  async getCredentials(userId: string): Promise<ShopifyCredentials> {
    return this.getForUser(userId);
  }
}
