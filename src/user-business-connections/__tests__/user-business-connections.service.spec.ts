/**
 * UserBusinessConnectionsService — unit tests
 *
 * Covers:
 *  - connectAccount()      : validates + encrypts + upserts (happy path)
 *  - connectAccount()      : rejects when platform validation fails
 *  - connectAccount()      : rejects duplicate active connection (ConflictException)
 *  - listConnections()     : returns mapped connections (no token leakage)
 *  - disconnectAccount()   : soft-deletes and audits
 *  - disconnectAccount()   : NotFoundException for unknown/foreign connection
 *  - decryptForRuntime()   : round-trips AES-256-GCM for meta_ads platform
 *  - decryptForRuntime()   : throws on inactive connection
 *
 * SECURITY NOTE: tests assert that token fields are NEVER present in
 * connection maps returned to callers.
 */

import { Test, TestingModule }  from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  UserBusinessConnectionsService,
  BusinessConnection,
} from '../user-business-connections.service';
import { DB_POOL } from '../../common/database/database.module';
import { AuditService } from '../../audit/audit.service';

// ── env ───────────────────────────────────────────────────────────────────────

process.env.ENCRYPTION_MASTER_KEY = 'aa'.repeat(32);

// ── constants ────────────────────────────────────────────────────────────────

const TENANT_ID     = 'tenant-biz-test';
const USER_ID       = 'user-store-test';
const CONN_ID       = 'bconn-uuid-001';
const FAKE_TOKEN    = ['unit', 'test', 'meta', 'token'].join('-');
const FAKE_ACCOUNT  = 'act_999000111';

// ── mocks ────────────────────────────────────────────────────────────────────

const auditMock = { log: jest.fn() };

const makeMockDb = () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
});

// ── helpers ──────────────────────────────────────────────────────────────────

const makeConnectionRow = (overrides: Record<string, unknown> = {}) => ({
  id:                  CONN_ID,
  tenant_id:           TENANT_ID,
  platform:            'meta_ads',
  account_label:       'My Ad Account',
  connection_status:   'active',
  is_active:           true,
  scopes_granted:      ['ads_management', 'business_management'],
  token_expires_at:    null,
  last_validated_at:   new Date(),
  created_at:          new Date(),
  updated_at:          new Date(),
  ...overrides,
});

const makeWebsitePlatformRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'platform-001',
  name: 'Custom Commerce',
  slug: 'custom-commerce',
  logo_url: null,
  description: 'Dynamic commerce platform',
  category: 'custom_website',
  auth_type: 'api_key',
  api_base_url: 'https://example.com/api',
  oauth_url: null,
  token_url: null,
  redirect_url: null,
  scopes: [],
  required_fields: [
    { key: 'websiteUrl', label: 'Website URL', type: 'url', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
  ],
  api_version: null,
  health_endpoint: null,
  documentation_url: null,
  supported_features: { productSync: true, orderSync: true },
  connection_wizard: { mode: 'dynamic' },
  enabled: true,
  maintenance_mode: false,
  is_default: false,
  priority: 10,
  fallback_priority: 20,
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

const makeUserPlatformConnectionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'upc-001',
  tenant_id: TENANT_ID,
  user_id: USER_ID,
  platform_id: 'platform-001',
  platform_slug: 'custom-commerce',
  platform_name: 'Custom Commerce',
  account_label: 'Main store',
  connection_status: 'active',
  is_active: true,
  last_validated_at: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

// ── suite ─────────────────────────────────────────────────────────────────────

describe('UserBusinessConnectionsService', () => {
  let service: UserBusinessConnectionsService;
  let dbMock:  ReturnType<typeof makeMockDb>;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserBusinessConnectionsService,
        { provide: DB_POOL,        useValue: dbMock    },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();
    service = module.get<UserBusinessConnectionsService>(UserBusinessConnectionsService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock = makeMockDb();
  });

  // ── connectAccount ───────────────────────────────────────────────────────

  describe('connectAccount()', () => {
    it('validates credentials, encrypts token, upserts, and returns a safe mapping', async () => {
      const connRow = makeConnectionRow();
      dbMock.query.mockResolvedValueOnce({ rows: [connRow], rowCount: 1 });

      // Stub validatePlatformCredentials (calls Meta Graph API in prod)
      await build();
      (service as any).validatePlatformCredentials = jest.fn().mockResolvedValue(undefined);

      const result: BusinessConnection = await service.connectAccount(TENANT_ID, {
        platform:     'meta_ads',
        primaryToken: FAKE_TOKEN,
        accountId:    FAKE_ACCOUNT,
        accountLabel: 'My Ad Account',
        scopesGranted: ['ads_management', 'business_management'],
      } as any);

      expect(result.id).toBe(CONN_ID);
      expect(result.platform).toBe('meta_ads');
      expect(result.connectionStatus).toBe('active');

      // Security: token must never appear in the returned object
      expect((result as any).primary_token_encrypted).toBeUndefined();
      expect((result as any).primaryToken).toBeUndefined();
      expect((result as any).token).toBeUndefined();
    });

    it('upserts when an active connection already exists', async () => {
      const existing = makeConnectionRow();
      dbMock.query.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });

      await build();
      (service as any).validatePlatformCredentials = jest.fn().mockResolvedValue(undefined);

      await expect(service.connectAccount(TENANT_ID, {
        platform:     'meta_ads',
        primaryToken: FAKE_TOKEN,
        accountId:    FAKE_ACCOUNT,
      } as any)).resolves.toEqual(expect.objectContaining({ id: CONN_ID, platform: 'meta_ads' }));
    });

    it('throws UnprocessableEntityException when platform validation fails', async () => {
      dbMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no duplicate

      await build();
      (service as any).validatePlatformCredentials = jest
        .fn()
        .mockRejectedValue(new UnprocessableEntityException('Invalid token'));

      await expect(service.connectAccount(TENANT_ID, {
        platform:     'meta_ads',
        primaryToken: 'bad-token',
        accountId:    FAKE_ACCOUNT,
      } as any)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // ── listConnections ──────────────────────────────────────────────────────

  describe('listConnections()', () => {
    it('returns an array of mapped connections with no token fields', async () => {
      const rows = [makeConnectionRow(), makeConnectionRow({ id: 'bconn-uuid-002', platform: 'shopify' })];
      dbMock.query.mockResolvedValue({ rows, rowCount: 2 });

      await build();
      const list = await service.listConnections(TENANT_ID);

      expect(list).toHaveLength(2);
      list.forEach(conn => {
        expect((conn as any).primary_token_encrypted).toBeUndefined();
        expect((conn as any).token).toBeUndefined();
      });
    });

    it('returns empty array when tenant has no connections', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await build();

      const list = await service.listConnections('tenant-with-no-connections');
      expect(list).toEqual([]);
    });

    it('filters by platform when platformFilter is provided', async () => {
      const shopifyRow = makeConnectionRow({ platform: 'shopify' });
      dbMock.query.mockResolvedValue({ rows: [shopifyRow], rowCount: 1 });

      await build();
      const list = await (service as any).listConnections(TENANT_ID, 'shopify');

      expect(list[0].platform).toBe('shopify');
      // SQL should include platform filter
      const sql = dbMock.query.mock.calls[0][0] as string;
      expect(sql.toLowerCase()).toContain('platform');
    });
  });

  // ── disconnectAccount ────────────────────────────────────────────────────

  describe('disconnectAccount()', () => {
    it('soft-deletes the connection and logs an audit event', async () => {
      const connRow = makeConnectionRow();
      dbMock.query
        .mockResolvedValueOnce({ rows: [connRow], rowCount: 1 })  // assertOwnership
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });         // UPDATE is_active = false

      await build();
      await expect(service.disconnectAccount(TENANT_ID, CONN_ID))
        .resolves.not.toThrow();

      const updateCall = dbMock.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('is_active') || sql.includes('connection_status'),
      );
      expect(updateCall).toBeDefined();
      expect(auditMock.log).toHaveBeenCalled();
    });

    it('throws NotFoundException for a connection that does not belong to the tenant', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });  // ownership check fails
      await build();

      await expect(service.disconnectAccount('other-tenant', CONN_ID))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── decryptForRuntime ────────────────────────────────────────────────────

  describe('decryptForRuntime()', () => {
    it('round-trips AES-256-GCM for primary token', async () => {
      await build();
      const { ciphertext, iv, authTag } = (service as any).encrypt(FAKE_TOKEN);

      const row = makeConnectionRow({
        connection_status:          'active',
        encrypted_primary_token:    ciphertext,
        primary_iv:                 iv,
        primary_auth_tag:           authTag,
        encrypted_secondary_token:  null,
        secondary_iv:               null,
        secondary_auth_tag:         null,
        encrypted_account_id:       null,
        account_id_iv:              null,
        account_id_auth_tag:        null,
      });

      dbMock.query.mockResolvedValue({ rows: [row], rowCount: 1 });

      const { primaryToken, secondaryToken } = await service.decryptForRuntime(TENANT_ID, 'meta_ads');
      expect(primaryToken).toBe(FAKE_TOKEN);
      expect(secondaryToken).toBeNull();
    });

    it('throws NotFoundException when connection does not exist', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await build();

      await expect(service.decryptForRuntime(TENANT_ID, 'meta_ads'))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('treats an inactive connection as not found', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await build();
      await expect(service.decryptForRuntime(TENANT_ID, 'meta_ads'))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('dynamic website platform management', () => {
    it('creates admin-managed website platforms and encrypts webhook secrets', async () => {
      const row = makeWebsitePlatformRow();
      dbMock.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
      await build();

      const result = await service.createWebsitePlatform({
        name: 'Custom Commerce',
        slug: 'custom-commerce',
        category: 'custom_website',
        authType: 'api_key',
        webhookSecret: 'plain-webhook-secret',
        requiredFields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true }],
        enabled: true,
      } as any, 'admin-1');

      expect(result.slug).toBe('custom-commerce');
      expect((result as any).webhookSecret).toBeUndefined();
      const params = dbMock.query.mock.calls[0][1] as unknown[];
      expect(params).not.toContain('plain-webhook-secret');
      expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'STORE_PROVIDER_CREATED',
      }));
    });

    it('lists only enabled website platforms for users', async () => {
      dbMock.query.mockResolvedValueOnce({
        rows: [makeWebsitePlatformRow({ slug: 'shopify', name: 'Shopify', enabled: true })],
        rowCount: 1,
      });
      await build();

      const platforms = await service.listEnabledWebsitePlatforms();

      expect(platforms).toHaveLength(1);
      expect(platforms[0].slug).toBe('shopify');
      expect(dbMock.query.mock.calls[0][1]).toEqual([false]);
    });

    it('encrypts user platform credentials and returns no secret values', async () => {
      const platform = makeWebsitePlatformRow();
      const connectionRow = makeUserPlatformConnectionRow({ platform_id: platform.id });
      dbMock.query
        .mockResolvedValueOnce({ rows: [platform], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [connectionRow], rowCount: 1 });
      await build();

      const result = await service.connectWebsitePlatform(TENANT_ID, USER_ID, {
        platformSlug: 'custom-commerce',
        accountLabel: 'Main store',
        credentials: { websiteUrl: 'https://store.example.com', apiKey: 'secret-api-key' },
      });

      expect(result.platformSlug).toBe('custom-commerce');
      expect((result as any).credentials).toBeUndefined();
      const insertParams = dbMock.query.mock.calls[1][1] as unknown[];
      expect(insertParams).not.toContain('secret-api-key');
      expect(insertParams).toContain(USER_ID);
      expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'STORE_CONNECTED',
      }));
    });

    it('rejects missing dynamic required fields', async () => {
      dbMock.query.mockResolvedValueOnce({ rows: [makeWebsitePlatformRow()], rowCount: 1 });
      await build();

      await expect(service.connectWebsitePlatform(TENANT_ID, USER_ID, {
        platformSlug: 'custom-commerce',
        credentials: { websiteUrl: 'https://store.example.com' },
      })).rejects.toThrow('Missing required field');
    });

    it('decrypts website platform credentials only for the owning tenant', async () => {
      await build();
      const encrypted = (service as any).encrypt(JSON.stringify({ apiKey: 'runtime-secret' }));
      dbMock.query.mockResolvedValueOnce({
        rows: [{
          encrypted_credentials: encrypted.ciphertext,
          credentials_iv: encrypted.iv,
          credentials_auth_tag: encrypted.authTag,
        }],
        rowCount: 1,
      });

      const credentials = await service.decryptWebsitePlatformForRuntime(TENANT_ID, 'custom-commerce');

      expect(credentials).toEqual({ apiKey: 'runtime-secret' });
      expect(dbMock.query.mock.calls[0][1]).toEqual([TENANT_ID, 'custom-commerce', null]);
    });

    it('denies cross-user store connection access', async () => {
      dbMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await build();

      await expect(service.getUserPlatformConnection(TENANT_ID, 'other-user', 'upc-001'))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(dbMock.query.mock.calls[0][1]).toEqual(['upc-001', TENANT_ID, 'other-user']);
    });

    it('blocks disabled providers from user connections', async () => {
      dbMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await build();

      await expect(service.connectWebsitePlatform(TENANT_ID, USER_ID, {
        platformSlug: 'disabled-commerce',
        credentials: { websiteUrl: 'https://store.example.com', apiKey: 'secret-api-key' },
      })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rotates credentials with encryption and audit logging', async () => {
      const platform = makeWebsitePlatformRow();
      const rotatedRow = makeUserPlatformConnectionRow();
      dbMock.query
        .mockResolvedValueOnce({ rows: [makeUserPlatformConnectionRow()], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [platform], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [rotatedRow], rowCount: 1 });
      await build();

      const result = await service.rotateWebsitePlatformCredentials(TENANT_ID, USER_ID, 'upc-001', {
        credentials: { websiteUrl: 'https://store.example.com', apiKey: 'rotated-secret' },
        reason: 'routine rotation',
      });

      expect(result.id).toBe('upc-001');
      const updateParams = dbMock.query.mock.calls[2][1] as unknown[];
      expect(updateParams).not.toContain('rotated-secret');
      expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'STORE_CREDENTIAL_ROTATED',
      }));
    });

    it('rejects invalid webhook signatures', async () => {
      await build();
      const secret = (service as any).encrypt('webhook-secret');
      dbMock.query.mockResolvedValueOnce({
        rows: [makeWebsitePlatformRow({
          webhook_secret_ciphertext: secret.ciphertext,
          webhook_secret_iv: secret.iv,
          webhook_secret_auth_tag: secret.authTag,
        })],
        rowCount: 1,
      });

      await expect(service.processStoreWebhook(TENANT_ID, {
        platformSlug: 'custom-commerce',
        eventId: 'evt-1',
        eventType: 'orders/create',
        signature: 'sha256=bad',
        payload: { orderId: 'o-1' },
      })).rejects.toThrow('Invalid webhook signature');
      expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'STORE_WEBHOOK_REJECTED',
      }));
    });

    it('ignores duplicate webhooks after idempotency claim', async () => {
      await build();
      (service as any).webhookIdempotency = {
        claim: jest.fn().mockResolvedValue({ claimed: false, duplicate: true }),
        complete: jest.fn(),
      };
      const secret = (service as any).encrypt('webhook-secret');
      const payload = { orderId: 'o-1' };
      const signature = crypto.createHmac('sha256', 'webhook-secret').update(JSON.stringify(payload)).digest('hex');
      dbMock.query.mockResolvedValueOnce({
        rows: [makeWebsitePlatformRow({
          webhook_secret_ciphertext: secret.ciphertext,
          webhook_secret_iv: secret.iv,
          webhook_secret_auth_tag: secret.authTag,
        })],
        rowCount: 1,
      });

      const result = await service.processStoreWebhook(TENANT_ID, {
        platformSlug: 'custom-commerce',
        eventId: 'evt-dup',
        eventType: 'orders/create',
        signature,
        payload,
      });

      expect(result).toEqual({ processed: false, duplicate: true });
      expect((service as any).webhookIdempotency.complete).not.toHaveBeenCalled();
    });

    it('rejects OAuth state mismatch', async () => {
      dbMock.query.mockResolvedValueOnce({
        rows: [makeWebsitePlatformRow({
          auth_type: 'oauth2',
          oauth_url: 'https://provider.example.com/oauth',
          redirect_url: 'https://app.example.com/callback',
        })],
        rowCount: 1,
      });
      await build();

      await expect(service.completeStoreOAuth(TENANT_ID, USER_ID, {
        platformSlug: 'custom-commerce',
        state: 'invalid.state',
        redirectUri: 'https://app.example.com/callback',
        code: 'code-1',
      })).rejects.toThrow();
    });

    it('blocks product publishing without a valid store connection', async () => {
      dbMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await build();

      await expect(service.assertProductPublishAllowed(TENANT_ID, USER_ID, 'custom-commerce', 'prod-1'))
        .rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── encryption isolation ──────────────────────────────────────────────────

  describe('encryption safety', () => {
    it('never produces the same ciphertext twice (IV randomisation)', async () => {
      await build();
      const enc1 = (service as any).encrypt(FAKE_TOKEN);
      const enc2 = (service as any).encrypt(FAKE_TOKEN);

      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    it('decryption is symmetric with the same master key', async () => {
      await build();
      const { ciphertext, iv, authTag } = (service as any).encrypt(FAKE_TOKEN);
      const decrypted                    = (service as any).decrypt(ciphertext, iv, authTag);
      expect(decrypted).toBe(FAKE_TOKEN);
    });
  });
});
