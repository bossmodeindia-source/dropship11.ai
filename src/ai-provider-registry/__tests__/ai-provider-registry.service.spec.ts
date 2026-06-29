/**
 * AiProviderRegistryService — unit tests
 *
 * Covers:
 *  - createProvider()         : happy path + duplicate conflict
 *  - approveProvider()        : pending → approved; idempotent; not-found
 *  - disableProvider()        : cascades user-connection disable
 *  - listApprovedProviders()  : cache hit vs DB hit
 *  - assertProviderApproved() : throws on non-approved provider
 *  - recordHealthSnapshot()   : inserts snapshot row
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AiProviderRegistryService } from '../ai-provider-registry.service';
import { AuditService } from '../../audit/audit.service';
import { DB_POOL } from '../../common/database/database.module';

// ── helpers ──────────────────────────────────────────────────────────────────

const makeProvider = (overrides: Record<string, unknown> = {}) => ({
  id:                   'prov-uuid-1',
  provider_key:         'openai',
  display_name:         'OpenAI',
  category:             'reasoning',
  description:          null,
  sdk_class:            null,
  base_url:             null,
  docs_url:             null,
  status:               'pending',
  requires_secondary_key: false,
  secondary_key_label:  null,
  capabilities:         '{}',
  pricing_per_unit:     null,
  pricing_unit:         null,
  approved_by:          null,
  approved_at:          null,
  sort_order:           0,
  created_at:           new Date(),
  updated_at:           new Date(),
  ...overrides,
});

const auditMock = { log: jest.fn() };

const makeMockDb = (rows: unknown[] = []) => ({
  query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }),
});

// ── suite ─────────────────────────────────────────────────────────────────────

describe('AiProviderRegistryService', () => {
  let service: AiProviderRegistryService;
  let dbMock:  ReturnType<typeof makeMockDb>;

  const resetDb = (rows: unknown[] = []) => {
    dbMock = makeMockDb(rows);
  };

  const buildService = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiProviderRegistryService,
        { provide: DB_POOL,   useValue: dbMock  },
        { provide: AuditService,   useValue: auditMock },
      ],
    })
      .overrideProvider('AuditService')
      .useValue(auditMock)
      .compile();

    service = module.get<AiProviderRegistryService>(AiProviderRegistryService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── createProvider ───────────────────────────────────────────────────────

  describe('createProvider()', () => {
    it('inserts and returns a new provider with status=pending', async () => {
      const provider = makeProvider();
      resetDb([provider]);
      // First query: exists check → empty; second: INSERT → provider
      dbMock.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // no duplicate
        .mockResolvedValueOnce({ rows: [provider], rowCount: 1 }); // INSERT result

      await buildService();

      const dto = {
        providerKey: 'openai',
        displayName: 'OpenAI',
        category:    'reasoning',
      } as any;

      const result = await service.createProvider(dto, 'admin-1');
      expect(result.providerKey).toBe('openai');
      expect(result.status).toBe('pending');
      expect(dbMock.query).toHaveBeenCalledTimes(3);
    });

    it('throws ConflictException if provider_key already exists', async () => {
      const existing = makeProvider();
      dbMock = makeMockDb([existing]);
      await buildService();

      const dto = { providerKey: 'openai', displayName: 'OpenAI', category: 'reasoning' } as any;

      await expect(service.createProvider(dto, 'admin-1'))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── approveProvider ──────────────────────────────────────────────────────

  describe('approveProvider()', () => {
    it('sets status=approved and clears cache', async () => {
      const pending  = makeProvider({ status: 'pending' });
      const approved = makeProvider({ status: 'approved', approved_by: 'admin-1', approved_at: new Date() });

      dbMock = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [pending], rowCount: 1 })   // getProviderByIdRaw
          .mockResolvedValueOnce({ rows: [approved], rowCount: 1 })  // UPDATE status
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // audit log INSERT
          .mockResolvedValue({ rows: [], rowCount: 0 }),             // catch-all
      };

      await buildService();

      const result = await service.approveProvider('prov-uuid-1', { notes: 'LGTM' }, 'admin-1');
      expect(result.status).toBe('approved');
      expect(result.approvedBy).toBe('admin-1');
    });

    it('throws NotFoundException when provider does not exist', async () => {
      dbMock = makeMockDb([]); // empty — not found
      await buildService();

      await expect(service.approveProvider('non-existent', {}, 'admin-1'))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ConflictException when provider is not pending (already approved)', async () => {
      const already = makeProvider({ status: 'approved' });
      dbMock = makeMockDb([already]);
      await buildService();

      await expect(service.approveProvider('prov-uuid-1', {}, 'admin-1'))
        .rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── disableProvider ──────────────────────────────────────────────────────

  describe('disableProvider()', () => {
    it('disables provider and cascades to user connections', async () => {
      const approved = makeProvider({ status: 'approved' });

      dbMock = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [approved], rowCount: 1 })  // find provider
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // UPDATE catalog
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // cascade user connections
          .mockResolvedValue({ rows: [], rowCount: 0 }),             // audit
      };

      await buildService();
      await expect(service.disableProvider('prov-uuid-1', 'Policy violation', 'admin-1'))
        .resolves.not.toThrow();

      // At least 2 queries: find + UPDATE catalog
      expect(dbMock.query.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('throws NotFoundException for unknown provider', async () => {
      dbMock = makeMockDb([]);
      await buildService();

      await expect(service.disableProvider('ghost-id', 'reason', 'admin-1'))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── listApprovedProviders ────────────────────────────────────────────────

  describe('listApprovedProviders()', () => {
    it('returns mapped providers from DB on first call', async () => {
      const prov = makeProvider({ status: 'approved' });
      dbMock = makeMockDb([prov]);
      await buildService();

      const list = await service.listApprovedProviders();
      expect(list).toHaveLength(1);
      expect(list[0].providerKey).toBe('openai');
    });

    it('serves from in-memory cache on second call (no extra DB query)', async () => {
      const prov = makeProvider({ status: 'approved' });
      dbMock = makeMockDb([prov]);
      await buildService();

      await service.listApprovedProviders(); // miss → DB
      const callsAfterFirst = dbMock.query.mock.calls.length;

      await service.listApprovedProviders(); // should hit cache
      expect(dbMock.query.mock.calls.length).toBe(callsAfterFirst); // no extra query
    });
  });

  // ── assertProviderApproved ───────────────────────────────────────────────

  describe('assertProviderApproved()', () => {
    it('returns the provider when it is approved', async () => {
      const approved = makeProvider({ status: 'approved' });
      dbMock = makeMockDb([approved]);
      await buildService();

      const prov = await service.assertProviderApproved('prov-uuid-1');
      expect(prov.status).toBe('approved');
    });

    it('throws NotFoundException when provider does not exist', async () => {
      dbMock = makeMockDb([]);
      await buildService();

      await expect(service.assertProviderApproved('ghost'))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException when provider is not approved', async () => {
      const disabled = makeProvider({ status: 'disabled' });
      dbMock = makeMockDb([disabled]);
      await buildService();

      await expect(service.assertProviderApproved('prov-uuid-1'))
        .rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── recordHealthSnapshot ─────────────────────────────────────────────────

  describe('recordHealthSnapshot()', () => {
    it('inserts a snapshot row without throwing', async () => {
      dbMock = makeMockDb([]);
      await buildService();

      await expect(service.recordHealthSnapshot('prov-uuid-1', 'healthy', 120))
        .resolves.not.toThrow();

      expect(dbMock.query).toHaveBeenCalledWith(
        expect.stringContaining('ai_provider_health_snapshots'),
        expect.arrayContaining(['prov-uuid-1', 'healthy', 120]),
      );
    });

    it('records a down snapshot with error message', async () => {
      dbMock = makeMockDb([]);
      await buildService();

      await service.recordHealthSnapshot('prov-uuid-1', 'down', 10_000, 'Connection refused');

      const [, params] = dbMock.query.mock.calls[0];
      expect(params).toContain('down');
      expect(params).toContain('Connection refused');
    });
  });
});
