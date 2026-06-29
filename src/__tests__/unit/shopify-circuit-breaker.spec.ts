/**
 * ShopifyCircuitBreaker — V66 Unit Tests
 *
 * Tests all state transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
 */

import { Test, TestingModule }  from '@nestjs/testing';
import {
  ShopifyCircuitBreaker,
  CircuitState,
  CircuitOpenError,
} from '../../shopify/shopify-circuit-breaker.service';
<<<<<<< HEAD
import { getRedisToken } from '../../common/redis/inject-redis';
=======
import { getRedisToken } from '@liaoliaots/nestjs-redis';
>>>>>>> a1b8c0c1cff445126259345924e07d81a359e9bd

describe('ShopifyCircuitBreaker', () => {
  let breaker: ShopifyCircuitBreaker;
  let mockRedis: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide:  ShopifyCircuitBreaker,
          useFactory: (redis: any) => new ShopifyCircuitBreaker(redis, {
            name:             'shopify-test',
            errorThreshold:   3,
            successThreshold: 2,
            timeout:          500,
            resetTimeout:     200,
            errorWindowMs:    10_000,
          }),
          inject: [getRedisToken('default')],
        },
        { provide: getRedisToken('default'), useValue: mockRedis },
      ],
    }).compile();

    breaker = module.get<ShopifyCircuitBreaker>(ShopifyCircuitBreaker);
  });

  describe('CLOSED state', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should execute operation and return result when CLOSED', async () => {
      const result = await breaker.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('should remain CLOSED after fewer failures than threshold', async () => {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('CLOSED → OPEN transition', () => {
    it('should OPEN after errorThreshold failures', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(() => Promise.reject(new Error('Shopify 500'))).catch(() => {});
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should persist OPEN state to Redis', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      expect(mockRedis.set).toHaveBeenCalledWith(
        'circuit:shopify-test:state',
        expect.stringContaining('OPEN'),
        'EX',
        300,
      );
    });
  });

  describe('OPEN state', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should throw CircuitOpenError when OPEN (no fallback)', async () => {
      await expect(
        breaker.execute(() => Promise.resolve('should not run')),
      ).rejects.toThrow(CircuitOpenError);
    });

    it('should call fallback queue instead of throwing when OPEN', async () => {
      const fallback = jest.fn().mockResolvedValue('queued');
      const result = await breaker.execute(
        () => Promise.resolve('direct'),
        fallback,
      );
      expect(result).toBe('queued');
      expect(fallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('OPEN → HALF_OPEN transition', () => {
    it('should transition to HALF_OPEN after resetTimeout', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      await new Promise(r => setTimeout(r, 250)); // wait past resetTimeout (200ms)

      // Next call should probe (HALF_OPEN)
      await breaker.execute(() => Promise.resolve('probe'));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('HALF_OPEN → CLOSED recovery', () => {
    it('should CLOSE after successThreshold successes in HALF_OPEN', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 250));

      // 2 successful probes should close
      await breaker.execute(() => Promise.resolve('ok1'));
      await breaker.execute(() => Promise.resolve('ok2'));

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('timeout protection', () => {
    it('should reject operations that exceed timeout threshold', async () => {
      let slowTimer: ReturnType<typeof setTimeout> | undefined;
      const slowOp = () => new Promise<string>(r => {
        slowTimer = setTimeout(() => r('slow'), 1000);
      });

      try {
        await expect(breaker.execute(slowOp)).rejects.toThrow('timed out');
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
      }
    });
  });

  describe('getMetrics', () => {
    it('should return current circuit metrics', () => {
      const metrics = breaker.getMetrics();
      expect(metrics).toMatchObject({
        state:    CircuitState.CLOSED,
        failures: 0,
        successes: 0,
      });
    });
  });
});
