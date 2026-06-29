import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { IdempotencyService } from '../idempotency.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

const redisMock = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
};

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        { provide: REDIS_CLIENT, useValue: redisMock },
      ],
    }).compile();

    service = module.get<IdempotencyService>(IdempotencyService);
  });

  describe('claim()', () => {
    it('returns true when Redis SET NX succeeds (new key)', async () => {
      redisMock.set.mockResolvedValueOnce('OK');
      const result = await service.claim('key-123');
      expect(result).toBe(true);
    });

    it('returns false when Redis SET NX fails (duplicate key)', async () => {
      redisMock.set.mockResolvedValueOnce(null);
      const result = await service.claim('key-123');
      expect(result).toBe(false);
    });

    it('calls Redis SET with correct NX and EX flags', async () => {
      redisMock.set.mockResolvedValueOnce('OK');
      await service.claim('my-key');

      expect(redisMock.set).toHaveBeenCalledWith(
        'idempotency:webhook:my-key',
        'processing',
        'EX',
        86_400,
        'NX',
      );
    });
  });

  describe('guardOrThrow()', () => {
    it('does not throw when key is new', async () => {
      redisMock.set.mockResolvedValueOnce('OK');
      await expect(service.guardOrThrow('new-key')).resolves.not.toThrow();
    });

    it('throws ConflictException when key is duplicate', async () => {
      redisMock.set.mockResolvedValueOnce(null);
      await expect(service.guardOrThrow('dup-key')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('complete()', () => {
    it('overwrites key with done:<orderId> value', async () => {
      redisMock.set.mockResolvedValueOnce('OK');
      await service.complete('my-key', 'order-uuid-1');

      expect(redisMock.set).toHaveBeenCalledWith(
        'idempotency:webhook:my-key',
        'done:order-uuid-1',
        'EX',
        86_400,
      );
    });
  });

  describe('release()', () => {
    it('deletes the Redis key', async () => {
      redisMock.del.mockResolvedValueOnce(1);
      await service.release('my-key');
      expect(redisMock.del).toHaveBeenCalledWith('idempotency:webhook:my-key');
    });
  });
});
