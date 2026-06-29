/**
 * RedisHealthGuard — V66 Unit Tests
 *
 * Tests NORMAL → DEGRADED → FAIL_CLOSED state transitions.
 * Verifies critical financial routes are blocked when Redis is down.
 */

import { Test, TestingModule }      from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { Reflector }                from '@nestjs/core';
import { ExecutionContext }         from '@nestjs/common';
import {
  RedisHealthGuard,
  RedisHealthState,
} from '../../common/redis/redis-health.guard';
import { getRedisToken }            from '../../common/redis/inject-redis';

function makeCtx(path: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path }),
    }),
    getHandler: jest.fn(),
    getClass:   jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RedisHealthGuard (V66 Fail-Closed)', () => {
  let guard: RedisHealthGuard;
  let mockRedis: { ping: jest.Mock };
  let reflector: Reflector;
  let module: TestingModule;

  beforeEach(async () => {
    mockRedis = { ping: jest.fn().mockResolvedValue('PONG') };

    module = await Test.createTestingModule({
      providers: [
        RedisHealthGuard,
        { provide: getRedisToken('default'), useValue: mockRedis },
        Reflector,
      ],
    }).compile();

    guard     = module.get<RedisHealthGuard>(RedisHealthGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('NORMAL state', () => {
    it('should allow all routes when Redis is healthy', async () => {
      expect(guard.getState()).toBe(RedisHealthState.NORMAL);
      await expect(guard.canActivate(makeCtx('/api/payment/capture'))).resolves.toBe(true);
      await expect(guard.canActivate(makeCtx('/webhooks/shopify/orders/paid'))).resolves.toBe(true);
      await expect(guard.canActivate(makeCtx('/api/products'))).resolves.toBe(true);
    });
  });

  describe('FAIL_CLOSED state', () => {
    beforeEach(() => {
      // Force the guard into FAIL_CLOSED by injecting state directly
      (guard as any).state             = RedisHealthState.FAIL_CLOSED;
      (guard as any).consecutiveFailures = 5;
    });

    it('should block /api/payment/* when fail-closed', async () => {
      await expect(
        guard.canActivate(makeCtx('/api/payment/capture')),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should block /api/escrow/* when fail-closed', async () => {
      await expect(
        guard.canActivate(makeCtx('/api/escrow/release')),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should block /api/withdrawal/* when fail-closed', async () => {
      await expect(
        guard.canActivate(makeCtx('/api/withdrawal/request')),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should block /api/supplier-payment/* when fail-closed', async () => {
      await expect(
        guard.canActivate(makeCtx('/api/supplier-payment/disburse')),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should block /webhooks/* when fail-closed', async () => {
      await expect(
        guard.canActivate(makeCtx('/webhooks/shopify/orders/paid')),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should ALLOW non-critical routes even when fail-closed', async () => {
      await expect(
        guard.canActivate(makeCtx('/api/products')),
      ).resolves.toBe(true);

      await expect(
        guard.canActivate(makeCtx('/health')),
      ).resolves.toBe(true);
    });
  });

  describe('probe recovery', () => {
    it('should return to NORMAL after Redis becomes available again', async () => {
      (guard as any).state              = RedisHealthState.FAIL_CLOSED;
      (guard as any).consecutiveFailures = 5;

      mockRedis.ping.mockResolvedValue('PONG');
      await (guard as any).probeRedis();

      expect(guard.getState()).toBe(RedisHealthState.NORMAL);
      expect((guard as any).consecutiveFailures).toBe(0);
    });

    it('should transition to DEGRADED after 3 consecutive failures', async () => {
      mockRedis.ping.mockRejectedValue(new Error('ECONNREFUSED'));

      for (let i = 0; i < 3; i++) {
        await (guard as any).probeRedis();
      }

      expect(guard.getState()).toBe(RedisHealthState.DEGRADED);
    });

    it('should transition to FAIL_CLOSED after 5 consecutive failures', async () => {
      mockRedis.ping.mockRejectedValue(new Error('ECONNREFUSED'));

      for (let i = 0; i < 5; i++) {
        await (guard as any).probeRedis();
      }

      expect(guard.getState()).toBe(RedisHealthState.FAIL_CLOSED);
    });
  });

  describe('error message', () => {
    it('should include a user-friendly retry message in 503 response', async () => {
      (guard as any).state = RedisHealthState.FAIL_CLOSED;

      try {
        await guard.canActivate(makeCtx('/api/payment/capture'));
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect((err as ServiceUnavailableException).message).toContain('retry in 30 seconds');
      }
    });
  });
});
