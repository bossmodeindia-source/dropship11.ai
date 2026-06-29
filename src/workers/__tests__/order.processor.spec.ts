import { Test, TestingModule } from '@nestjs/testing';
import { OrderProcessor } from '../order.processor';
import { SupplierService } from '../../supplier/supplier.service';
import { OrderQueueService } from '../../orders/order-queue.service';
import { AuditService } from '../../audit/audit.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';

const mockOrder = {
  id: 'order-uuid-1', userId: 'user-uuid-1', platformOrderId: 'plat-001',
  status: 'queued', quantity: 1, unitPrice: '29.99', totalAmount: '29.99',
  currency: 'USD', supplierType: 'mock', shippingAddress: {}, retryCount: 0,
};

const dbMock: any = {
  query: { orders: { findFirst: jest.fn() } },
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  transaction: jest.fn(async (fn: (tx: any) => Promise<void>) => fn(dbMock)),
};

const supplierMock = {
  placeOrder: jest.fn().mockResolvedValue({ supplierOrderId: 'SUP-001', status: 'confirmed' }),
};
const queueMock  = { moveToDlq: jest.fn().mockResolvedValue(undefined) };
const auditMock  = { log: jest.fn().mockResolvedValue(undefined) };
const configMock = { get: jest.fn((k: string, d?: unknown) => k === 'ORDER_QUEUE' ? 'order:process' : d) };
const redisMock  = { duplicate: jest.fn().mockReturnValue({ on: jest.fn() }) };

describe('OrderProcessor', () => {
  let processor: OrderProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    dbMock.update.mockReturnValue(dbMock);
    dbMock.set.mockReturnValue(dbMock);
    dbMock.where.mockReturnValue(dbMock);
    dbMock.insert.mockReturnValue(dbMock);
    dbMock.values.mockReturnValue(dbMock);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderProcessor,
        { provide: DB_TOKEN,          useValue: dbMock },
        { provide: REDIS_CLIENT,      useValue: redisMock },
        { provide: SupplierService,   useValue: supplierMock },
        { provide: OrderQueueService, useValue: queueMock },
        { provide: AuditService,      useValue: auditMock },
        { provide: ConfigService,     useValue: configMock },
      ],
    }).compile();

    processor = module.get<OrderProcessor>(OrderProcessor);
  });

  type Proc = { process: (job: unknown) => Promise<void>; handleExhaustedRetries: (job: unknown, err: Error) => Promise<void> };

  const makeJob = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-1', attemptsMade: 0,
    data: { orderId: 'order-uuid-1', userId: 'user-uuid-1', platformOrderId: 'plat-001', supplierType: 'mock', retryCount: 0, ...overrides },
  });

  it('throws UnrecoverableError when order not found', async () => {
    dbMock.query.orders.findFirst.mockResolvedValueOnce(null);
    await expect((processor as unknown as Proc).process(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('skips processing when order already delivered', async () => {
    dbMock.query.orders.findFirst.mockResolvedValueOnce({ ...mockOrder, status: 'delivered' });
    await (processor as unknown as Proc).process(makeJob());
    expect(supplierMock.placeOrder).not.toHaveBeenCalled();
  });

  it('calls supplier and writes audit on success', async () => {
    dbMock.query.orders.findFirst.mockResolvedValueOnce(mockOrder);
    await (processor as unknown as Proc).process(makeJob());
    expect(supplierMock.placeOrder).toHaveBeenCalledTimes(1);
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'order.fulfilled' }));
  });

  it('re-throws supplier error for BullMQ retry', async () => {
    dbMock.query.orders.findFirst.mockResolvedValueOnce(mockOrder);
    supplierMock.placeOrder.mockRejectedValueOnce(new Error('Timeout'));
    await expect((processor as unknown as Proc).process(makeJob())).rejects.toThrow('Timeout');
  });

  it('handleExhaustedRetries moves order to DLQ and audits failure', async () => {
    const job = makeJob();
    await (processor as unknown as Proc).handleExhaustedRetries(job, new Error('Perm fail'));
    expect(queueMock.moveToDlq).toHaveBeenCalledWith(job.data, 'Perm fail');
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'order.failed' }));
  });
});
