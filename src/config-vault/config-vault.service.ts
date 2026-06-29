/**
 * ConfigVaultService
 *
 * Single source of truth for ALL external API credentials.
 * NO service in the codebase reads process.env directly — everything flows here.
 *
 * Key lifecycle:
 *  1. On startup: load from process.env (optional — missing keys → provider inactive)
 *  2. Admin can inject/rotate keys at runtime via POST /admin/keys/set
 *  3. Keys are AES-256-GCM encrypted at rest in the `api_keys` table
 *  4. In-memory LRU cache with configurable TTL avoids DB reads on every request
 *
 * Operational modes (automatic, no config required):
 *  MOCK   — no keys at all → all providers return deterministic mock responses
 *  PARTIAL — some keys present → available providers used, rest fall back to BOT
 *  FULL   — all keys present → full AI pipeline enabled
 */

import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { EncryptionService } from '../common/crypto/encryption.service';

export type ProviderKey =
  | 'NVIDIA_49B_API_KEY'
  | 'NVIDIA_253B_API_KEY'
  | 'NVIDIA_BASE_URL'
  | 'MUAPI_API_KEY'
  | 'MUAPI_BASE_URL'
  | 'NEMOGUARD_API_KEY'
  | 'META_APP_SECRET'
  | 'META_ACCESS_TOKEN';

export interface KeyEntry {
  value:     string;
  source:    'env' | 'db' | 'admin';
  updatedAt: Date;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory cache

@Injectable()
export class ConfigVaultService implements OnModuleInit {
  private readonly logger = new Logger(ConfigVaultService.name);
  private readonly cache  = new Map<ProviderKey, { entry: KeyEntry; expiresAt: number }>();

  // Fallback defaults (non-secret configuration only)
  private readonly defaults: Partial<Record<ProviderKey, string>> = {
    NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    MUAPI_BASE_URL:  'https://api.muapi.io/v1',
  };

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly encryption: EncryptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadFromEnv();
    this.logger.log('[ConfigVault] Initialised — keys loaded from environment');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Retrieve a key value. Returns undefined if the key is not configured.
   * Callers must treat undefined as "provider unavailable" — never throw.
   */
  async get(key: ProviderKey): Promise<string | undefined> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.entry.value;
    }

    // L2: try DB (admin-injected keys override env)
    try {
      const row = await this.db.query.apiKeys.findFirst({
        where: eq(schema.apiKeys.keyName, key),
      });
      if (row?.encryptedValue) {
        const value = await this.encryption.decrypt(row.encryptedValue);
        this.setCache(key, { value, source: 'db', updatedAt: row.updatedAt });
        return value;
      }
    } catch {
      // DB unavailable — fall through to cached/env value
    }

    // L3: env-loaded value (set during onModuleInit)
    return this.defaults[key];
  }

  /**
   * Returns true if the key exists AND is non-empty.
   * Used by providers to declare availability.
   */
  async isAvailable(key: ProviderKey): Promise<boolean> {
    const value = await this.get(key);
    return !!value && value.length > 0 && !value.startsWith('mock');
  }

  /**
   * Admin runtime injection — encrypted to DB, cache invalidated.
   * Called by POST /admin/keys/set
   */
  async set(key: ProviderKey, value: string, source: 'admin' | 'db' = 'admin'): Promise<void> {
    const encrypted = await this.encryption.encrypt(value);

    await this.db
      .insert(schema.apiKeys)
      .values({
        keyName:        key,
        encryptedValue: encrypted,
        source,
        updatedAt:      new Date(),
      })
      .onConflictDoUpdate({
        target:  schema.apiKeys.keyName,
        set: {
          encryptedValue: encrypted,
          source,
          updatedAt:      new Date(),
        },
      });

    // Bust cache so next call reads fresh value
    this.cache.delete(key);
    this.logger.log(`[ConfigVault] Key ${key} updated by ${source}`);
  }

  /**
   * Rotate a key — atomically replace value without downtime.
   */
  async rotate(key: ProviderKey, newValue: string): Promise<void> {
    return this.set(key, newValue, 'admin');
  }

  /**
   * Status report for the admin dashboard.
   * Returns availability without exposing raw values.
   */
  async getStatus(): Promise<Record<ProviderKey, { available: boolean; source: string; updatedAt?: Date }>> {
    const keys: ProviderKey[] = [
      'NVIDIA_49B_API_KEY',
      'NVIDIA_253B_API_KEY',
      'NVIDIA_BASE_URL',
      'MUAPI_API_KEY',
      'MUAPI_BASE_URL',
      'NEMOGUARD_API_KEY',
      'META_APP_SECRET',
      'META_ACCESS_TOKEN',
    ];

    const result = {} as Record<ProviderKey, { available: boolean; source: string; updatedAt?: Date }>;

    for (const key of keys) {
      const available = await this.isAvailable(key);
      const cached    = this.cache.get(key);
      result[key] = {
        available,
        source:    cached?.entry.source ?? 'none',
        updatedAt: cached?.entry.updatedAt,
      };
    }

    return result;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async loadFromEnv(): Promise<void> {
    const envMap: Record<ProviderKey, string | undefined> = {
      NVIDIA_49B_API_KEY:   process.env['NVIDIA_CHAT_49B_API_KEY'],
      NVIDIA_253B_API_KEY:  process.env['NVIDIA_STRATEGY_253B_API_KEY'],
      NVIDIA_BASE_URL:      process.env['NVIDIA_BASE_URL'],
      MUAPI_API_KEY:        process.env['MUAPI_API_KEY'],
      MUAPI_BASE_URL:       process.env['MUAPI_BASE_URL'],
      NEMOGUARD_API_KEY:    process.env['NEMOGUARD_API_KEY'],
      META_APP_SECRET:      process.env['META_APP_SECRET'],
      META_ACCESS_TOKEN:    process.env['META_ACCESS_TOKEN'],
    };

    for (const [key, value] of Object.entries(envMap)) {
      if (value && value.length > 0) {
        const finalValue = this.defaults[key as ProviderKey] ?? value;
        this.setCache(key as ProviderKey, {
          value:     finalValue,
          source:    'env',
          updatedAt: new Date(),
        });
      } else if (this.defaults[key as ProviderKey]) {
        this.setCache(key as ProviderKey, {
          value:     this.defaults[key as ProviderKey]!,
          source:    'env',
          updatedAt: new Date(),
        });
      }
    }
  }

  private setCache(key: ProviderKey, entry: KeyEntry): void {
    this.cache.set(key, { entry, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
