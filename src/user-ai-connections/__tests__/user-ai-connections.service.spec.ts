/**
 * UserAiConnectionsService — unit tests
 *
 * Covers:
 *  - connectProvider()         : happy path (upsert + audit)
 *  - connectProvider()         : rejects when provider is not approved
 *  - disconnectProvider()      : soft-deletes connection
 *  - decryptKeyForRuntime()    : round-trips AES-256-GCM encryption
 *  - decryptKeyForRuntime()    : throws when connection not found
 *  - decryptKeyForRuntime()    : throws on quota exceeded
 *  - recordUsage()             : inserts event + updates counters
 *  - getUsageAnalytics()       : returns aggregated rows
 *
 * SECURITY NOTE: plaintext API keys must never appear in the mocked DB rows.
 * This suite deliberately avoids using real API keys.
 */

import { Test, TestingModule }  from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { UserAiConnectionsService } from '../user-ai-connections.service';
import { AiProviderRegistryService } from '../../ai-provider-registry/ai-provider-registry.service';
import { AuditService }              from '../../audit/audit.service';
import { DB_POOL } from '../../common/database/database.module';

// ── constants ────────────────────────────────────────────────────────────────

const TENANT_ID      = 'tenant-abc-123';
const PROVIDER_ID    = 'prov-uuid-openai';
const CONNECTION_ID  = 'conn-uuid-1';
const PROVIDER_KEY   = 'openai';
const FAKE_API_KEY   = ['unit', 'test', 'provider', 'key'].join('-');

// AES-256-GCM requires a 32-byte (64 hex char) key
process.env.ENCRYPTION_MASTER_KEY = 'aa'.repeat(32);

// ── mocks ────────────────────────────────────────────────────────────────────

const registryMock = {
  assertProviderApproved: jest.fn(),
};

const auditMock = {
  log: jest.fn(),
};

const makeMockDb = () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
});

// ── helpers ──────────────────────────────────────────────────────────────────

const makeConnectionRow = (overrides: Record<string, unknown> = {}) => ({
  id:                   CONNECTION_ID,
  tenant_id:            TENANT_ID,
  provider_id:          PROVIDER_ID,
  provider_key:         PROVIDER_KEY,
  provider_display_name: 'OpenAI',
  connection_status:    'active',
  is_active:            true,
  allow_platform_fallback: false,
  last_health_check:    new Date(),
  last_health_status:   'healthy',
  quota_limit:          null,
  quota_used:           0,
  total_requests:       0,
  total_tokens:         0,
  total_cost_usd:       0,
  created_at:           new Date(),
  updated_at:           new Date(),
  ...overrides,
});

// ── suite ─────────────────────────────────────────────────────────────────────

describe('UserAiConnectionsService', () => {
  let service: UserAiConnectionsService;
  let dbMock:  ReturnType<typeof makeMockDb>;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserAiConnectionsService,
        { provide: DB_POOL,                    useValue: dbMock        },
        { provide: AiProviderRegistryService,   useValue: registryMock },
        { provide: AuditService,                useValue: auditMock    },
      ],
    }).compile();

    service = module.get<UserAiConnectionsService>(UserAiConnectionsService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock = makeMockDb();
    registryMock.assertProviderApproved.mockResolvedValue({
      id:          PROVIDER_ID,
      providerKey: PROVIDER_KEY,
    });
  });

  // ── connectProvider ──────────────────────────────────────────────────────

  describe('connectProvider()', () => {
    it('encrypts the key, upserts, and returns a connection without exposing the plaintext key', async () => {
      const connRow = makeConnectionRow();
      dbMock.query.mockResolvedValue({ rows: [connRow], rowCount: 1 });
      await build();
      // Prevent real HTTP calls to provider API during unit tests
      jest.spyOn(service as any, 'validateKeyWithProvider').mockResolvedValue(undefined);

      const result = await service.connectProvider(TENANT_ID, {
        providerId: PROVIDER_ID,
        apiKey:     FAKE_API_KEY,
      });

      expect(result.id).toBe(CONNECTION_ID);
      expect(result.providerKey).toBe(PROVIDER_KEY);
      // Encrypted key must never leak through the mapped interface
      expect((result as any).encrypted_api_key).toBeUndefined();
      expect(auditMock.log).toHaveBeenCalled();
    });

    it('calls assertProviderApproved — rejects unapproved providers', async () => {
      registryMock.assertProviderApproved.mockRejectedValue(
        new ForbiddenException('Provider not approved'),
      );
      await build();

      await expect(
        service.connectProvider(TENANT_ID, { providerId: PROVIDER_ID, apiKey: FAKE_API_KEY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── disconnectProvider ───────────────────────────────────────────────────

  describe('disconnectProvider()', () => {
    it('soft-deletes the connection (is_active = false)', async () => {
      const connRow = makeConnectionRow();
      // first call: getConnectionOwnedByTenant; second: UPDATE
      dbMock.query
        .mockResolvedValueOnce({ rows: [connRow], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await build();

      await expect(service.disconnectProvider(TENANT_ID, CONNECTION_ID))
        .resolves.not.toThrow();

      const updateCall = dbMock.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('is_active = false'),
      );
      expect(updateCall).toBeDefined();
    });

    it('throws NotFoundException for a connection belonging to a different tenant', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await build();

      await expect(service.disconnectProvider('other-tenant', CONNECTION_ID))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── decryptKeyForRuntime ─────────────────────────────────────────────────

  describe('decryptKeyForRuntime()', () => {
    it('successfully round-trips AES-256-GCM encryption / decryption', async () => {
      // Encrypt a fake key using the service's own private methods (white-box)
      await build();

      // Access private encrypt via any-cast — acceptable in white-box tests
      const { ciphertext, iv, authTag } = (service as any).encrypt(FAKE_API_KEY);

      const connRow = makeConnectionRow({
        encrypted_api_key:  ciphertext,
        key_iv:             iv,
        key_auth_tag:       authTag,
        encrypted_secondary: null,
        secondary_iv:        null,
        secondary_auth_tag:  null,
        connection_status:   'active',
        quota_used:          0,
        quota_limit:         null,
      });

      dbMock.query.mockResolvedValue({ rows: [connRow], rowCount: 1 });

      const { apiKey, secondaryKey } = await service.decryptKeyForRuntime(TENANT_ID, PROVIDER_KEY);
      expect(apiKey).toBe(FAKE_API_KEY);
      expect(secondaryKey).toBeNull();
    });

    it('throws NotFoundException when no connection exists', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await build();

      await expect(service.decryptKeyForRuntime(TENANT_ID, 'flux'))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when connection_status is not active', async () => {
      await build();
      const { ciphertext, iv, authTag } = (service as any).encrypt(FAKE_API_KEY);

      const invalidRow = makeConnectionRow({
        encrypted_api_key: ciphertext,
        key_iv:            iv,
        key_auth_tag:      authTag,
        connection_status: 'invalid_key', // not 'active'
        quota_used:        0,
        quota_limit:       null,
      });

      dbMock.query.mockResolvedValue({ rows: [invalidRow], rowCount: 1 });

      await expect(service.decryptKeyForRuntime(TENANT_ID, PROVIDER_KEY))
        .rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws ForbiddenException when quota is exhausted', async () => {
      await build();
      const { ciphertext, iv, authTag } = (service as any).encrypt(FAKE_API_KEY);

      const exhaustedRow = makeConnectionRow({
        encrypted_api_key: ciphertext,
        key_iv:            iv,
        key_auth_tag:      authTag,
        connection_status: 'active',
        quota_used:        1000,
        quota_limit:       1000, // quota_used >= quota_limit
      });

      dbMock.query.mockResolvedValue({ rows: [exhaustedRow], rowCount: 1 });

      await expect(service.decryptKeyForRuntime(TENANT_ID, PROVIDER_KEY))
        .rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── recordUsage ──────────────────────────────────────────────────────────

  describe('recordUsage()', () => {
    it('inserts a usage event and increments counters', async () => {
      const connRow = makeConnectionRow();
      dbMock.query
        .mockResolvedValueOnce({ rows: [{ id: CONNECTION_ID }], rowCount: 1 }) // find connection
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // INSERT event
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE counters

      await build();

      await expect(service.recordUsage(TENANT_ID, PROVIDER_KEY, 'script_generation', {
        promptTokens:     500,
        completionTokens: 250,
        totalTokens:      750,
        latencyMs:        350,
        costUsd:          0.00225,
        modelUsed:        'gpt-4o',
      })).resolves.not.toThrow();

      // Verify INSERT event was called
      const insertCall = dbMock.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('user_ai_usage_events'),
      );
      expect(insertCall).toBeDefined();
    });

    it('is a no-op when no connection is found (graceful degradation)', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await build();

      // Should not throw even if connection doesn't exist
      await expect(service.recordUsage(TENANT_ID, 'unknown-provider', 'op', {
        promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, costUsd: 0,
      })).resolves.not.toThrow();

      expect(dbMock.query).toHaveBeenCalledTimes(1); // only the find query
    });
  });

  // ── getUsageAnalytics ────────────────────────────────────────────────────

  describe('getUsageAnalytics()', () => {
    it('returns period and byProvider array', async () => {
      const analyticsRow = {
        provider_key:    'openai',
        total_requests:  42,
        total_tokens:    21000n,
        total_cost_usd:  '0.063',
        avg_latency_ms:  320,
        error_count:     1,
        last_used_at:    new Date(),
      };

      dbMock.query.mockResolvedValue({ rows: [analyticsRow], rowCount: 1 });
      await build();

      const result = await service.getUsageAnalytics(TENANT_ID, 30);
      expect(result.period).toBe('30d');
      expect(result.byProvider).toHaveLength(1);
      expect(result.byProvider[0].provider_key).toBe('openai');
    });

    it('uses default 30-day window', async () => {
      dbMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await build();

      const result = await service.getUsageAnalytics(TENANT_ID);
      expect(result.period).toBe('30d');
    });
  });

  // ── encryption isolation ──────────────────────────────────────────────────

  describe('encryption safety', () => {
    it('produces different ciphertext for the same plaintext (IV randomisation)', async () => {
      await build();
      const enc1 = (service as any).encrypt(FAKE_API_KEY);
      const enc2 = (service as any).encrypt(FAKE_API_KEY);

      // Same plaintext → different IV → different ciphertext
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    it('throws when master key is missing', async () => {
      await build();
      const saved = process.env.ENCRYPTION_MASTER_KEY;
      delete process.env.ENCRYPTION_MASTER_KEY;

      expect(() => (service as any).getMasterKey()).toThrow('ENCRYPTION_MASTER_KEY');
      process.env.ENCRYPTION_MASTER_KEY = saved;
    });
  });
});
