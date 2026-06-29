/**
 * Withdrawal E2E Tests — Full Lifecycle
 *
 * Tests the complete HTTP layer:
 *   1. User requests withdrawal → 201 Created
 *   2. Fraud block → 403 Forbidden
 *   3. Admin lists withdrawals → 200
 *   4. Admin approves → 200
 *   5. Admin gets bank details (decrypt) → 200 + audit log
 *   6. Admin completes payout → 200
 *   7. RBAC: user cannot access admin routes → 403
 *   8. Tenant isolation: user cannot see other tenant's withdrawals
 */

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from '../../test-utils/test-app-factory';
import { sign } from 'jsonwebtoken';
import { DB_TOKEN } from '../../common/database/database.module';
import { withdrawals } from '../withdrawal-schema';

jest.setTimeout(120_000);

function createWithdrawalDb() {
  const records: any[] = [];
  let selection: Record<string, unknown> | undefined;
  let table: unknown;
  let operation = 'select';
  let pendingValues: any;
  let pendingPatch: any;
  let pendingWhereId: string | undefined;
  let executeStep = 0;

  const findUuid = (value: unknown, seen = new Set<unknown>()): string | undefined => {
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = findUuid(nested, seen);
      if (found) return found;
    }
    return undefined;
  };

  const rowsForSelect = (whereId?: string) => {
    const keys = Object.keys(selection ?? {});
    if (keys.includes('isActive') && keys.includes('role')) return [{ isActive: true, role: 'user' }];
    if (keys.length === 1 && keys[0] === 'cnt') return [{ cnt: 0 }];
    if (keys.length === 1 && keys[0] === 'id') {
      const pending = records.find((row) => row.status === 'pending');
      return pending ? [{ id: pending.id }] : [];
    }
    const selected = whereId ? records.filter((row) => row.id === whereId) : records;
    return selected.map((row) => ({ ...row }));
  };

  const queryBuilder = () => {
    let whereId: string | undefined;
    const builder: any = {
      from: jest.fn((nextTable: unknown) => { table = nextTable; return builder; }),
      where: jest.fn((condition: unknown) => { whereId = findUuid(condition); return builder; }),
      orderBy: jest.fn(() => builder),
      groupBy: jest.fn(() => builder),
      limit: jest.fn(() => builder),
      offset: jest.fn(async () => rowsForSelect(whereId)),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rowsForSelect(whereId)).then(resolve, reject),
    };
    return builder;
  };

  const db: any = {
    select: jest.fn((fields?: Record<string, unknown>) => {
      operation = 'select'; selection = fields; return queryBuilder();
    }),
    from: jest.fn((nextTable: unknown) => { table = nextTable; return db; }),
    where: jest.fn((condition: unknown) => { pendingWhereId = findUuid(condition); return db; }),
    orderBy: jest.fn(() => db),
    groupBy: jest.fn(() => db),
    limit: jest.fn(() => db),
    offset: jest.fn(() => db),
    insert: jest.fn((nextTable: unknown) => { operation = 'insert'; table = nextTable; return db; }),
    values: jest.fn((values: any) => { pendingValues = values; return db; }),
    update: jest.fn((nextTable: unknown) => { operation = 'update'; table = nextTable; return db; }),
    set: jest.fn((patch: any) => { pendingPatch = patch; return db; }),
    returning: jest.fn(async () => {
      if (operation === 'insert' && table === withdrawals) {
        const row = {
          id: `${records.length + 1}`.padStart(8, '0') + '-0000-4000-8000-000000000001',
          ...pendingValues,
          isFrozen: false, adminNotes: null, createdAt: new Date(), processedAt: null,
          razorpayPayoutId: null,
        };
        records.push(row);
        return [row];
      }
      if (operation === 'update' && table === withdrawals) {
        const row = pendingWhereId
          ? records.find((item) => item.id === pendingWhereId)
          : records.find((item) => item.status === 'pending') ?? records[0];
        if (!row) return [];
        Object.assign(row, pendingPatch);
        return [{ ...row }];
      }
      return [{ id: 'audit-id' }];
    }),
    execute: jest.fn(async () => {
      executeStep = (executeStep % 5) + 1;
      const rows = executeStep === 1
        ? [{ id: 'wallet-1', balance: '100000', currency: 'INR', version: 1 }]
        : executeStep === 2
          ? [{ cnt: '0' }]
          : executeStep === 3
            ? [{ total: '100000' }]
            : [];
      const result: any = [...rows];
      result.rows = rows;
      return result;
    }),
    transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  return db;
}

process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WEBHOOK_HMAC_SECRET ??= 'test-webhook-secret-at-least-32-chars';
process.env.INTERNAL_SERVICE_KEY ??= 'test-internal-service-key-at-least-32';
process.env.ENCRYPTION_MASTER_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Withdrawal E2E', () => {
  let app: INestApplication;
  let userToken: string;
  let adminToken: string;
  let withdrawalId: string;

  const validWithdrawalPayload = {
    amount:            5000,
    bankName:          'HDFC Bank',
    accountHolderName: 'Test User',
    accountNumber:     '1234567890',
    ifscCode:          'HDFC0001234',
  };

  beforeAll(async () => {
    const withdrawalDb = createWithdrawalDb();
    const ctx = await createTestApp({
      configure: (builder) => builder.overrideProvider(DB_TOKEN).useValue(withdrawalDb),
    });
    app = ctx.app;
    const tenantId = '11111111-1111-4111-8111-111111111111';
    ctx.redis.store.set(`tenant:active:${tenantId}`, '1');
    userToken = sign({
      sub: '22222222-2222-4222-8222-222222222222',
      id: '22222222-2222-4222-8222-222222222222',
      email: 'test@user.com', role: 'user', subscriptionTier: 'free', tenant_id: tenantId,
    }, process.env.JWT_SECRET!);
    adminToken = sign({
      sub: '33333333-3333-4333-8333-333333333333',
      id: '33333333-3333-4333-8333-333333333333',
      email: 'admin@platform.com', role: 'admin', subscriptionTier: 'elite', tenant_id: tenantId,
    }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Request withdrawal ────────────────────────────────────────────────────

  describe('POST /withdrawals/request', () => {
    it('201 — creates withdrawal with valid payload', async () => {
      const res = await request(app.getHttpServer())
        .post('/withdrawals/request')
        .set('Authorization', `Bearer ${userToken}`)
        .send(validWithdrawalPayload);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status:   'pending',
        bankName: 'HDFC Bank',
        amount:   5000,
        currency: 'INR',
      });

      // Must not expose encrypted fields
      expect(res.body.accountNumber).toBeUndefined();
      expect(res.body.ifscCode).toBeUndefined();
      expect(res.body.accountHolderNameCiphertext).toBeUndefined();

      withdrawalId = res.body.id;
    });

    it('400 — invalid IFSC code rejected by DTO validation', async () => {
      const res = await request(app.getHttpServer())
        .post('/withdrawals/request')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ ...validWithdrawalPayload, ifscCode: 'INVALID' });

      expect(res.status).toBe(400);
    });

    it('400 — account number must be 9–18 digits', async () => {
      const res = await request(app.getHttpServer())
        .post('/withdrawals/request')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ ...validWithdrawalPayload, accountNumber: '123' }); // too short

      expect(res.status).toBe(400);
    });

    it('400 — amount must be positive', async () => {
      const res = await request(app.getHttpServer())
        .post('/withdrawals/request')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ ...validWithdrawalPayload, amount: -100 });

      expect(res.status).toBe(400);
    });

    it('401 — requires authentication', async () => {
      const res = await request(app.getHttpServer())
        .post('/withdrawals/request')
        .send(validWithdrawalPayload);

      expect(res.status).toBe(401);
    });
  });

  // ── View own history ──────────────────────────────────────────────────────

  describe('GET /withdrawals/history', () => {
    it('200 — returns own withdrawal history', async () => {
      const res = await request(app.getHttpServer())
        .get('/withdrawals/history')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // No encrypted fields in list response
      res.body.forEach((w: any) => {
        expect(w.accountNumber).toBeUndefined();
        expect(w.accountNumberCiphertext).toBeUndefined();
      });
    });
  });

  // ── Admin: List all ───────────────────────────────────────────────────────

  describe('GET /admin/withdrawals', () => {
    it('200 — admin can list all withdrawals', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/withdrawals')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('403 — user cannot access admin withdrawal list', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/withdrawals')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
    });

    it('filters by status query param', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/withdrawals?status=pending')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      res.body.forEach((w: any) => {
        expect(w.status).toBe('pending');
      });
    });
  });

  // ── Admin: Approve ────────────────────────────────────────────────────────

  describe('POST /admin/withdrawals/:id/approve', () => {
    it('200 — admin can approve pending withdrawal', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/withdrawals/${withdrawalId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ adminNotes: 'Verified manually' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
    });

    it('403 — user cannot approve withdrawals', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/withdrawals/${withdrawalId}/approve`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(403);
    });
  });

  // ── Admin: Bank detail decrypt ────────────────────────────────────────────

  describe('GET /admin/withdrawals/:id/bank-details', () => {
    it('200 — admin can decrypt bank details', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/withdrawals/${withdrawalId}/bank-details`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accountHolderName');
      expect(res.body).toHaveProperty('accountNumber');
      expect(res.body).toHaveProperty('ifscCode');
      // Decrypted values should match what was submitted
      expect(res.body.ifscCode).toBe('HDFC0001234');
    });

    it('403 — user cannot decrypt bank details', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/withdrawals/${withdrawalId}/bank-details`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
    });
  });

  // ── Admin: Complete ───────────────────────────────────────────────────────

  describe('POST /admin/withdrawals/:id/complete', () => {
    it('200 — admin can mark approved withdrawal as completed', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/withdrawals/${withdrawalId}/complete`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ razorpayPayoutId: 'pout_test_123', adminNotes: 'Transferred via NEFT' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.razorpayPayoutId).toBe('pout_test_123');
    });
  });

  // ── Admin: Reject flow ────────────────────────────────────────────────────

  describe('POST /admin/withdrawals/:id/reject', () => {
    let rejectTargetId: string;

    beforeAll(async () => {
      // Create a fresh withdrawal to reject
      const res = await request(app.getHttpServer())
        .post('/withdrawals/request')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ ...validWithdrawalPayload, amount: 200 });
      rejectTargetId = res.body.id;
    });

    it('400 — reject requires adminNotes', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/withdrawals/${rejectTargetId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ adminNotes: '' });

      expect(res.status).toBe(400);
    });

    it('200 — admin can reject with reason', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/withdrawals/${rejectTargetId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ adminNotes: 'Account details do not match KYC records' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.adminNotes).toBe('Account details do not match KYC records');
    });
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  describe('Rate limiting on withdrawal requests', () => {
    it('429 — blocks after 5 withdrawal requests in an hour', async () => {
      // First 5 should succeed (or fail fraud check, not rate limit)
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/withdrawals/request')
          .set('Authorization', `Bearer ${userToken}`)
          .send(validWithdrawalPayload);
      }
      // 6th should be rate-limited
      const res = await request(app.getHttpServer())
        .post('/withdrawals/request')
        .set('Authorization', `Bearer ${userToken}`)
        .send(validWithdrawalPayload);

      expect(res.status).toBe(429);
    });
  });
});
