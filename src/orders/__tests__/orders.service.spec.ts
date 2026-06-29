import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../orders.service';
import { IdempotencyService } from '../idempotency.service';
import { OrderQueueService } from '../order-queue.service';
import { AuditService } from '../../audit/audit.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { WebhookOrderDto } from '../dto/webhook-order.dto';

const mockOrder = {
  id: 'order-uuid-1',
  userId: 'user-uuid-1',
  platformOrderId: 'shopify-1234',
  status: 'received',
  idempotencyKey: 'shopify:shopify-1234',
  quantity: 1,
  unitPrice: '29.99',
  totalAmount: '29.99',
  currency: 'USD',
  retryCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const dbMock: any = {
  query: {
    orders: { findFirst: jest.fn(), findMany: jest.fn() },
    orderStatusLog: { findMany: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  transaction: jest.fn(async (fn: (tx: any) => Promise<void>) => fn(dbMock)),
};

const idempotencyMock = {
  guardOrThrow: jest.fn(),
  complete: jest.fn(),
  release: jest.fn(),
};

const queueMock = {
  enqueueOrder: jest.fn().mockResolvedValue('job-id-1'),
  getQueueDepth: jest.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0, dlq: 0 }),
};

const auditMock = { log: jest.fn() };

describe('OrdersService', () => {
  let service: OrdersService;

  const dto: WebhookOrderDto = {
    platformOrderId: 'shopify-1234',
    platform: 'shopify',
    unitPrice: 29.99,
    totalAmount: 29.99,
    quantity: 1,
    currency: 'USD',
    supplierType: 'mock',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    dbMock.insert.mockReturnValue(dbMock);
    dbMock.values.mockReturnValue(dbMock);
    dbMock.update.mockReturnValue(dbMock);
    dbMock.set.mockReturnValue(dbMock);
    dbMock.where.mockReturnValue(dbMock);
    dbMock.returning.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DB_TOKEN,           useValue: dbMock },
        { provide: IdempotencyService,  useValue: idempotencyMock },
        { provide: OrderQueueService,   useValue: queueMock },
        { provide: AuditService,        useValue: auditMock },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  // ── handleWebhook ────────────────────────────────────────────────

  describe('handleWebhook()', () => {
    it('persists order and enqueues job, returns orderId and jobId', async () => {
      idempotencyMock.guardOrThrow.mockResolvedValueOnce(undefined);
      dbMock.returning
        .mockResolvedValueOnce([{ id: 'order-uuid-1' }]) // insert order
        .mockResolvedValueOnce([])                        // insert status log (no return)
        .mockResolvedValueOnce([]);                       // update status
      dbMock.insert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: 'order-uuid-1' }]) }) });

      // Direct mock for the full insert chain
      dbMock.returning.mockResolvedValue([{ id: 'order-uuid-1' }]);

      const result = await service.handleWebhook('user-uuid-1', dto);

      expect(result).toHaveProperty('orderId');
      expect(result).toHaveProperty('jobId');
      expect(result.status).toBe('queued');
    });

    it('releases idempotency key when DB insert throws', async () => {
      idempotencyMock.guardOrThrow.mockResolvedValueOnce(undefined);
      dbMock.returning.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(
        service.handleWebhook('user-uuid-1', dto),
      ).rejects.toThrow('DB connection lost');

      expect(idempotencyMock.release).toHaveBeenCalledWith('shopify:shopify-1234');
    });

    it('throws when idempotency guard rejects (duplicate)', async () => {
      idempotencyMock.guardOrThrow.mockRejectedValueOnce(
        new ConflictException('Duplicate webhook'),
      );

      await expect(
        service.handleWebhook('user-uuid-1', dto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('uses dto.idempotencyKey when provided', async () => {
      idempotencyMock.guardOrThrow.mockResolvedValueOnce(undefined);
      dbMock.returning.mockResolvedValueOnce([{ id: 'order-uuid-1' }]);

      await service.handleWebhook('user-uuid-1', {
        ...dto,
        idempotencyKey: 'custom-key-abc',
      });

      expect(idempotencyMock.guardOrThrow).toHaveBeenCalledWith('custom-key-abc');
    });
  });

  // ── findOne ──────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('returns order when found', async () => {
      dbMock.query.orders.findFirst.mockResolvedValueOnce(mockOrder);
      const result = await service.findOne('user-uuid-1', 'order-uuid-1');
      expect(result).toEqual(mockOrder);
    });

    it('throws NotFoundException when order not found', async () => {
      dbMock.query.orders.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.findOne('user-uuid-1', 'nonexistent'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── getQueueStats ────────────────────────────────────────────────

  describe('getQueueStats()', () => {
    it('returns queue depth from queue service', async () => {
      const result = await service.getQueueStats();
      expect(result).toEqual({ waiting: 0, active: 0, failed: 0, dlq: 0 });
    });
  });
});
