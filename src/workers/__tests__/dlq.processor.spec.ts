import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DlqProcessor } from '../dlq.processor';
import { NotificationsService } from '../../notifications/notifications.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

// ── Mock BullMQ Worker ────────────────────────────────────────────────────────

const mockWorkerOn   = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_queue, _handler, _opts) => ({
    on:    mockWorkerOn,
    close: mockWorkerClose,
  })),
}));

// ── Test data ─────────────────────────────────────────────────────────────────

const mockJob = {
  id:           'job-dlq-1',
  attemptsMade: 5,
  data: {
    orderId:         'order-abc-123',
    userId:          'user-xyz',
    platformOrderId: 'SHOP-999',
    supplierType:    'aliexpress',
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DlqProcessor', () => {
  let processor: DlqProcessor;
  let notifications: jest.Mocked<NotificationsService>;

  beforeEach(async () => {
    const redisMock = { duplicate: jest.fn().mockReturnValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DlqProcessor,
        {
          provide:  REDIS_CLIENT,
          useValue: redisMock,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('order:dlq'),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyAdminOrderFailed: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    processor     = module.get<DlqProcessor>(DlqProcessor);
    notifications = module.get(NotificationsService);

    processor.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  it('should call notifyAdminOrderFailed for every dead-lettered job', async () => {
    // Access private method via type cast
    await (processor as any).handleDeadLetter(mockJob);

    expect(notifications.notifyAdminOrderFailed).toHaveBeenCalledWith(
      'order-abc-123',
      expect.stringContaining('aliexpress'),
    );
    expect(notifications.notifyAdminOrderFailed).toHaveBeenCalledTimes(1);
  });

  it('should include attempt count in the alert reason', async () => {
    await (processor as any).handleDeadLetter(mockJob);

    const [, reason] = (notifications.notifyAdminOrderFailed as jest.Mock).mock.calls[0];
    expect(reason).toContain('5');   // attemptsMade
  });

  it('should NOT throw if notifyAdminOrderFailed rejects (alert failure is non-fatal)', async () => {
    (notifications.notifyAdminOrderFailed as jest.Mock).mockRejectedValue(
      new Error('Resend API is down'),
    );

    // Must not throw — DLQ worker must acknowledge the job regardless
    await expect((processor as any).handleDeadLetter(mockJob)).resolves.toBeUndefined();
  });

  it('should NOT throw if alert throws synchronously', async () => {
    (notifications.notifyAdminOrderFailed as jest.Mock).mockImplementation(() => {
      throw new Error('Sync explosion');
    });

    await expect((processor as any).handleDeadLetter(mockJob)).resolves.toBeUndefined();
  });

  it('should still process the job when alert fails (non-fatal)', async () => {
    (notifications.notifyAdminOrderFailed as jest.Mock).mockRejectedValue(
      new Error('Network timeout'),
    );

    // handleDeadLetter must resolve (job gets acknowledged) even if alert fails
    const result = await (processor as any).handleDeadLetter(mockJob);
    expect(result).toBeUndefined();
  });

  it('should close the worker on module destroy', async () => {
    await processor.onModuleDestroy();
    expect(mockWorkerClose).toHaveBeenCalled();
  });
});
