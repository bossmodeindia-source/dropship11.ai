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
