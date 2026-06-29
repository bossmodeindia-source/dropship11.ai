/**
 * QueueIdempotencyService — V66 Unit Tests
 */

import { Test, TestingModule }     from '@nestjs/testing';
import { QueueIdempotencyService } from '../../common/queue/queue-idempotency.service';
import { getRedisToken }           from '../../common/redis/inject-redis';

describe('QueueIdempotencyService', () => {
  let service: QueueIdempotencyService;
  let mockRedis: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueIdempotencyService,
        { provide: getRedisToken('default'), useValue: mockRedis },
      ],
    }).compile();

    service = module.get<QueueIdempotencyService>(QueueIdempotencyService);
  });

  describe('check', () => {
    it('should return alreadyProcessed=false when key does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.check('fulfillment.process', 'job-1');
      expect(result.alreadyProcessed).toBe(false);
    });

    it('should return alreadyProcessed=true when key exists in Redis', async () => {
      mockRedis.get.mockResolvedValue('2026-01-01T00:00:00.000Z');
      const result = await service.check('fulfillment.process', 'job-1');
      expect(result.alreadyProcessed).toBe(true);
      expect(result.processedAt).toBeInstanceOf(Date);
    });

    it('should check the correct Redis key format', async () => {
      mockRedis.get.mockResolvedValue(null);
      await service.check('order.payment', 42);
      expect(mockRedis.get).toHaveBeenCalledWith('processed:order.payment:42');
    });

    it('should fail-open when Redis is unavailable', async () => {
      mockRedis.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await service.check('fulfillment.process', 'job-1');
      // Fail-open: treat as not processed (let job proceed)
      expect(result.alreadyProcessed).toBe(false);
    });
  });

  describe('markProcessed', () => {
    it('should set key with 24-hour TTL', async () => {
      await service.markProcessed('supplier.route', 'job-99');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'processed:supplier.route:job-99',
        expect.any(String),
        'EX',
        86400,
      );
    });

    it('should not throw when Redis is unavailable (non-fatal)', async () => {
      mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.markProcessed('job', '1')).resolves.not.toThrow();
    });
  });

  describe('guardExecution', () => {
    it('should execute processor and mark processed on first execution', async () => {
      mockRedis.get.mockResolvedValue(null);
      const processor = jest.fn().mockResolvedValue(undefined);

      const result = await service.guardExecution('ai.task', 'job-5', processor);

      expect(result.skipped).toBe(false);
      expect(processor).toHaveBeenCalledTimes(1);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'processed:ai.task:job-5',
        expect.any(String),
        'EX',
        86400,
      );
    });

    it('should skip processor and NOT mark if already processed', async () => {
      mockRedis.get.mockResolvedValue('2026-01-01T00:00:00.000Z');
      const processor = jest.fn();

      const result = await service.guardExecution('ai.task', 'job-5', processor);

      expect(result.skipped).toBe(true);
      expect(processor).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should NOT mark processed if processor throws', async () => {
      mockRedis.get.mockResolvedValue(null);
      const processor = jest.fn().mockRejectedValue(new Error('Processing failed'));

      await expect(
        service.guardExecution('payment.process', 'job-7', processor),
      ).rejects.toThrow('Processing failed');

      // Must NOT mark as processed if it failed
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should protect: fulfillment, supplier routing, payments, tracking, AI jobs', async () => {
      const jobTypes = [
        'fulfillment.process',
        'supplier.route',
        'payment.capture',
        'tracking.sync',
        'ai.task',
      ];

      mockRedis.get.mockResolvedValue(null);

      for (const jobType of jobTypes) {
        const processor = jest.fn().mockResolvedValue(undefined);
        const result = await service.guardExecution(jobType, 'job-x', processor);
        expect(result.skipped).toBe(false);
        expect(processor).toHaveBeenCalledTimes(1);
        processor.mockClear();
        mockRedis.set.mockClear();
      }
    });
  });
});
