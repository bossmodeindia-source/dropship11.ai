import { Test, TestingModule } from '@nestjs/testing';
import { AdminUsersService } from '../admin-users.service';
import { AuditService } from '../../audit/audit.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { NotFoundException, ConflictException } from '@nestjs/common';

const mockUser = {
  id: 'user-1', email: 'user@test.com', role: 'user',
  isActive: true, fullName: 'Test User', companyName: null,
  aiMode: 'BOT', createdAt: new Date(), updatedAt: new Date(),
  subscriptions: { tier: 'free', status: 'active' },
};

const mockAdminId = 'admin-1';

const dbMock = {
  query: {
    users:         { findFirst: jest.fn(), findMany: jest.fn() },
    subscriptions: { findFirst: jest.fn() },
    auditLogs:     { findMany: jest.fn() },
  },
  select:  jest.fn().mockReturnThis(),
  from:    jest.fn().mockReturnThis(),
  where:   jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  limit:   jest.fn().mockReturnThis(),
  update:  jest.fn().mockReturnThis(),
  set:     jest.fn().mockReturnThis(),
  insert:  jest.fn().mockReturnThis(),
  values:  jest.fn().mockReturnThis(),
  returning: jest.fn(),
};

const auditMock = { log: jest.fn(), findByUser: jest.fn() };

describe('AdminUsersService', () => {
  let service: AdminUsersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    dbMock.update.mockReturnValue(dbMock);
    dbMock.set.mockReturnValue(dbMock);
    dbMock.where.mockReturnValue(dbMock);
    dbMock.select.mockReturnValue(dbMock);
    dbMock.from.mockReturnValue(dbMock);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: DB_TOKEN,     useValue: dbMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<AdminUsersService>(AdminUsersService);
  });

  describe('findOne()', () => {
    it('returns user when found', async () => {
      dbMock.query.users.findFirst.mockResolvedValueOnce(mockUser);
      const result = await service.findOne('user-1');
      expect(result.id).toBe('user-1');
    });

    it('throws NotFoundException when user not found', async () => {
      dbMock.query.users.findFirst.mockResolvedValueOnce(null);
      await expect(service.findOne('ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('suspendUser()', () => {
    it('suspends a user and writes audit log', async () => {
      dbMock.returning.mockResolvedValueOnce([{ id: 'user-1', isActive: false }]);
      const result = await service.suspendUser(mockAdminId, 'user-1');
      expect(result.isActive).toBe(false);
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.suspended', resource: 'user' }),
      );
    });

    it('throws ConflictException when admin tries to suspend themselves', async () => {
      await expect(service.suspendUser(mockAdminId, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reactivateUser()', () => {
    it('reactivates a user', async () => {
      dbMock.returning.mockResolvedValueOnce([{ id: 'user-1', isActive: true }]);
      const result = await service.reactivateUser(mockAdminId, 'user-1');
      expect(result.isActive).toBe(true);
    });
  });

  describe('updateSubscription()', () => {
    it('updates subscription and writes audit log', async () => {
      dbMock.query.users.findFirst.mockResolvedValueOnce(mockUser);
      dbMock.returning.mockResolvedValueOnce([{ id: 'sub-1', tier: 'pro', status: 'active' }]);

      const result = await service.updateSubscription('user-1', { tier: 'pro' }, mockAdminId);
      expect(result.tier).toBe('pro');
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.changed' }),
      );
    });

    it('throws NotFoundException when user not found', async () => {
      dbMock.query.users.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.updateSubscription('ghost', { tier: 'pro' }, mockAdminId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
