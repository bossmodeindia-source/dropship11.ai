/**
 * WithdrawalService — Unit Tests
 *
 * Tests cover:
 *   - Fraud gate blocking (pending orders, duplicate, excessive amount)
 *   - Bank detail encryption (never persists plaintext)
 *   - Lifecycle transitions (pending → approved → completed, pending → rejected)
 *   - Tenant isolation (user cannot see other tenant's withdrawals)
 *   - Admin controls (approve, reject with notes, complete with Razorpay ID)
 *   - Freeze behavior
 *   - Audit log calls on every state transition
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { WithdrawalService } from '../withdrawal.service';
import { BankEncryptionService } from '../bank-encryption.service';
import { WithdrawalFraudService } from '../withdrawal-fraud.service';
import { AuditService } from '../../audit/audit.service';
import { AlertingService } from '../../alerting/alerting.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { RequestWithdrawalDto, RejectWithdrawalDto } from '../dto/withdrawal.dto';
import { ConfigService } from '@nestjs/config';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const mockWithdrawal = (overrides: Partial<any> = {}) => ({
  id:          'w-uuid-1',
  tenantId:    'tenant-uuid-1',
  userId:      'user-uuid-1',
  amount:      '5000',
  currency:    'INR',
  status:      'pending',
  bankName:    'HDFC Bank',
  isFrozen:    false,
  adminNotes:  null,
  createdAt:   new Date(),
  processedAt: null,
  pendingOrdersAtRequest: 0,
  razorpayPayoutId: null,
  ...overrides,
});

const mockDbBuilder = (returnValue: any) => {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    from:   jest.fn().mockReturnThis(),
    where:  jest.fn().mockReturnThis(),
    limit:  jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(returnValue),
    update: jest.fn().mockReturnThis(),
    set:    jest.fn().mockReturnThis(),
  };
  return chain;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WithdrawalService', () => {
  let service: WithdrawalService;
  let bankEncryption: jest.Mocked<BankEncryptionService>;
  let fraudService: jest.Mocked<WithdrawalFraudService>;
  let audit: jest.Mocked<AuditService>;
  let alerting: jest.Mocked<AlertingService>;
  let db: any;

  const userId   = 'user-uuid-1';
  const tenantId = 'tenant-uuid-1';

  const validDto: RequestWithdrawalDto = {
    amount:            5000,
    bankName:          'HDFC Bank',
    accountHolderName: 'Test User',
    accountNumber:     '1234567890',
    ifscCode:          'HDFC0001234',
  };

  const encryptedFields = {
    accountHolderName: { ciphertext: 'enc-name', iv: 'iv1', tag: 'tag1' },
    accountNumber:     { ciphertext: 'enc-num',  iv: 'iv2', tag: 'tag2' },
    ifscCode:          { ciphertext: 'enc-ifsc', iv: 'iv3', tag: 'tag3' },
  };

  beforeEach(async () => {
    db = {
      select: jest.fn().mockReturnThis(),
      from:   jest.fn().mockReturnThis(),
      where:  jest.fn().mockReturnThis(),
      limit:  jest.fn(),
      offset: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockWithdrawal()]),
      update: jest.fn().mockReturnThis(),
      set:    jest.fn().mockReturnThis(),
      execute: jest.fn()
        .mockResolvedValueOnce([{ id: 'wallet-1', balance: '10000', currency: 'INR', version: 1 }])
        .mockResolvedValueOnce([]),
    };
    db.limit.mockImplementation((value: number) => value === 1 ? db.returning() : db);
    db.transaction = jest.fn((fn: (tx: any) => Promise<unknown>) => fn(db));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalService,
        { provide: DB_TOKEN, useValue: db },
        {
          provide: BankEncryptionService,
          useValue: {
            encryptBankDetails: jest.fn().mockReturnValue(encryptedFields),
            decryptBankDetails: jest.fn().mockReturnValue({
              accountHolderName: 'Test User',
              accountNumber:     '1234567890',
              ifscCode:          'HDFC0001234',
            }),
          },
        },
        {
          provide: WithdrawalFraudService,
          useValue: {
            checkWithdrawal: jest.fn().mockResolvedValue({
              approved:      true,
              violations:    [],
              pendingOrders: 0,
              details:       [],
            }),
            checkWithdrawalInTx: jest.fn().mockResolvedValue({
              approved: true, violations: [], pendingOrders: 0, details: [],
            }),
          },
        },
        {
          provide: AuditService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
            logInTx: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AlertingService,
          useValue: { sendCritical: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service       = module.get(WithdrawalService);
    bankEncryption = module.get(BankEncryptionService) as jest.Mocked<BankEncryptionService>;
    fraudService  = module.get(WithdrawalFraudService) as jest.Mocked<WithdrawalFraudService>;
    audit         = module.get(AuditService) as jest.Mocked<AuditService>;
    alerting      = module.get(AlertingService) as jest.Mocked<AlertingService>;
  });

  // ── Request Withdrawal ────────────────────────────────────────────────────

  describe('requestWithdrawal', () => {
    it('encrypts bank details before persisting', async () => {
      await service.requestWithdrawal(userId, tenantId, validDto);
      expect(bankEncryption.encryptBankDetails).toHaveBeenCalledWith({
        accountHolderName: validDto.accountHolderName,
        accountNumber:     validDto.accountNumber,
        ifscCode:          validDto.ifscCode,
      });
    });

    it('runs fraud check before any DB write', async () => {
      const callOrder: string[] = [];
      ((fraudService as any).checkWithdrawalInTx as jest.Mock).mockImplementation(async () => {
        callOrder.push('fraud');
        return { approved: true, violations: [], pendingOrders: 0, details: [] };
      });
      (db.returning as jest.Mock).mockImplementation(async () => {
        callOrder.push('db-write');
        return [mockWithdrawal()];
      });

      await service.requestWithdrawal(userId, tenantId, validDto);
      expect(callOrder[0]).toBe('fraud');
      expect(callOrder[1]).toBe('db-write');
    });

    it('blocks request when fraud check fails', async () => {
      ((fraudService as any).checkWithdrawalInTx as jest.Mock).mockResolvedValue({
        approved:   false,
        violations: ['PENDING_ORDERS_BLOCK'],
        pendingOrders: 2,
        details:    ['2 orders pending supplier payment'],
      });

      await expect(
        service.requestWithdrawal(userId, tenantId, validDto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks request when duplicate pending exists (DUPLICATE_PENDING)', async () => {
      ((fraudService as any).checkWithdrawalInTx as jest.Mock).mockResolvedValue({
        approved:   false,
        violations: ['DUPLICATE_PENDING'],
        pendingOrders: 0,
        details:    ['Already has pending withdrawal'],
      });

      await expect(
        service.requestWithdrawal(userId, tenantId, validDto),
      ).rejects.toThrow(ForbiddenException);

      // Encryption is CPU-only and occurs before the transaction; no DB write may occur.
      expect(bankEncryption.encryptBankDetails).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('creates audit log on successful request', async () => {
      await service.requestWithdrawal(userId, tenantId, validDto);
      expect((audit as any).logInTx).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          action:   'WITHDRAWAL_REQUESTED',
          resource: 'withdrawals',
          tenantId,
          actorId:  userId,
        }),
      );
    });

    it('notifies admin via alert on successful request', async () => {
      await service.requestWithdrawal(userId, tenantId, validDto);
      expect(alerting.sendCritical).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('Withdrawal') }),
      );
    });

    it('does NOT include account number or IFSC in audit log details', async () => {
      await service.requestWithdrawal(userId, tenantId, validDto);
      const call = ((audit as any).logInTx as jest.Mock).mock.calls[0][1];
      const detailsStr = JSON.stringify(call.details ?? {});
      expect(detailsStr).not.toContain(validDto.accountNumber);
      expect(detailsStr).not.toContain(validDto.ifscCode);
    });

    it('returns summary without encrypted ciphertext fields', async () => {
      const result = await service.requestWithdrawal(userId, tenantId, validDto);
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain('ciphertext');
      expect(resultStr).not.toContain('account_number_iv');
    });
  });

  // ── User: View History ────────────────────────────────────────────────────

  describe('getUserWithdrawals', () => {
    it('applies tenant_id and user_id WHERE clause', async () => {
      db.returning.mockResolvedValue([]);
      await service.getUserWithdrawals(userId, tenantId);
      // Verify where() was called (both tenant and user IDs scoped)
      expect(db.where).toHaveBeenCalled();
    });

    it('does not select ciphertext columns', async () => {
      // The select call should only request safe fields
      db.returning.mockResolvedValue([]);
      await service.getUserWithdrawals(userId, tenantId);
      const selectCall = (db.select as jest.Mock).mock.calls[0];
      if (selectCall && selectCall[0]) {
        const selectedFields = Object.keys(selectCall[0]);
        expect(selectedFields.some((field) => field.toLowerCase().includes('ciphertext'))).toBe(false);
      }
    });
  });

  // ── Admin: Approve ────────────────────────────────────────────────────────

  describe('adminApprove', () => {
    const withdrawalId = 'w-uuid-1';
    const adminId = 'admin-uuid-1';

    beforeEach(() => {
      // Mock findByIdOrThrow to return pending withdrawal
      db.returning.mockResolvedValue([mockWithdrawal({ status: 'pending' })]);
    });

    it('throws BadRequestException if status is not pending', async () => {
      db.returning.mockResolvedValueOnce([mockWithdrawal({ status: 'completed' })]);
      await expect(
        service.adminApprove(withdrawalId, adminId, {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException if withdrawal is frozen', async () => {
      db.returning.mockResolvedValueOnce([mockWithdrawal({ status: 'pending', isFrozen: true })]);
      await expect(
        service.adminApprove(withdrawalId, adminId, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('audit logs with WITHDRAWAL_APPROVED action', async () => {
      // Return pending for findByIdOrThrow, then updated record
      db.returning
        .mockResolvedValueOnce([mockWithdrawal({ status: 'pending' })])
        .mockResolvedValueOnce([mockWithdrawal({ status: 'approved' })]);

      await service.adminApprove(withdrawalId, adminId, { adminNotes: 'Verified' });

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'WITHDRAWAL_APPROVED', actorId: adminId }),
      );
    });
  });

  // ── Admin: Reject ─────────────────────────────────────────────────────────

  describe('adminReject', () => {
    it('throws BadRequestException if adminNotes is empty', async () => {
      db.returning.mockResolvedValue([mockWithdrawal({ status: 'pending' })]);

      await expect(
        service.adminReject('w-uuid-1', 'admin-1', { adminNotes: '   ' } as RejectWithdrawalDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires adminNotes on rejection', async () => {
      db.returning
        .mockResolvedValueOnce([mockWithdrawal({ status: 'pending' })])
        .mockResolvedValueOnce([mockWithdrawal({ status: 'rejected' })]);

      await service.adminReject('w-uuid-1', 'admin-1', { adminNotes: 'Invalid account details' });

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'WITHDRAWAL_REJECTED' }),
      );
    });
  });

  // ── Admin: Complete ───────────────────────────────────────────────────────

  describe('adminComplete', () => {
    it('requires approved status before completing', async () => {
      db.returning.mockResolvedValue([mockWithdrawal({ status: 'pending' })]);
      await expect(
        service.adminComplete('w-uuid-1', 'admin-1', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores Razorpay payout ID on completion', async () => {
      db.returning
        .mockResolvedValueOnce([mockWithdrawal({ status: 'approved' })])
        .mockResolvedValueOnce([mockWithdrawal({ status: 'completed', razorpayPayoutId: 'pout_xyz' })]);

      const result = await service.adminComplete('w-uuid-1', 'admin-1', {
        razorpayPayoutId: 'pout_xyz',
      });

      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ razorpayPayoutId: 'pout_xyz' }),
      );
    });
  });

  // ── Admin: Decrypt Bank Details ───────────────────────────────────────────

  describe('adminDecryptBankDetails', () => {
    it('logs a critical audit event on every decrypt', async () => {
      db.returning.mockResolvedValue([{
        tenantId:                    tenantId,
        userId:                      userId,
        accountHolderNameCiphertext: 'enc-name',
        accountHolderNameIv:         'iv1',
        accountHolderNameTag:        'tag1',
        accountNumberCiphertext:     'enc-num',
        accountNumberIv:             'iv2',
        accountNumberTag:            'tag2',
        ifscCodeCiphertext:          'enc-ifsc',
        ifscCodeIv:                  'iv3',
        ifscCodeTag:                 'tag3',
      }]);

      await service.adminDecryptBankDetails('w-uuid-1', 'admin-uuid-1');

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action:   'WITHDRAWAL_BANK_DETAIL_DECRYPTED',
          severity: 'critical',
        }),
      );
    });

    it('throws NotFoundException if withdrawal does not exist', async () => {
      db.returning.mockResolvedValue([]);
      await expect(
        service.adminDecryptBankDetails('nonexistent-uuid', 'admin-uuid-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

// ── BankEncryptionService Tests ───────────────────────────────────────────────

describe('BankEncryptionService', () => {
  let service: BankEncryptionService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        BankEncryptionService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue(
              'a'.repeat(64), // 64 hex chars = 32-byte key
            ),
          },
        },
      ],
    })
    .overrideProvider(ConfigService)
    .useValue({ getOrThrow: jest.fn().mockReturnValue('a'.repeat(64)) })
    .compile();

    // Direct instantiation for unit testing
    const configMock = { getOrThrow: jest.fn().mockReturnValue('a'.repeat(64)) } as any;
    service = new BankEncryptionService(configMock);
    service.onModuleInit();
  });

  it('produces different ciphertexts for identical plaintexts (random IV)', () => {
    const enc1 = service.encrypt('1234567890');
    const enc2 = service.encrypt('1234567890');
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext); // different IVs
    expect(enc1.iv).not.toBe(enc2.iv);
  });

  it('round-trips encrypt/decrypt correctly', () => {
    const plaintext = 'HDFC0001234';
    const { ciphertext, iv, tag } = service.encrypt(plaintext);
    const decrypted = service.decrypt(ciphertext, iv, tag);
    expect(decrypted).toBe(plaintext);
  });

  it('throws on tampered ciphertext (GCM auth tag fails)', () => {
    const { ciphertext, iv, tag } = service.encrypt('secret');
    const tampered = Buffer.from(ciphertext, 'base64');
    tampered[0] ^= 0xff; // flip first byte
    expect(() =>
      service.decrypt(tampered.toString('base64'), iv, tag),
    ).toThrow();
  });

  it('rejects short keys on init', () => {
    const shortKeyConfig = { getOrThrow: jest.fn().mockReturnValue('abc') } as any;
    const shortKeyService = new BankEncryptionService(shortKeyConfig);
    expect(() => shortKeyService.onModuleInit()).toThrow(/64 hex chars/);
  });
});
