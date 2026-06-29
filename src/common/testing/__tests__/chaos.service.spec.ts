import { ChaosService, ChaosError } from '../chaos.service';
import { ConfigService } from '@nestjs/config';

function makeService(chaosMode = 'true', nodeEnv = 'test'): ChaosService {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'CHAOS_MODE') return chaosMode;
      if (key === 'NODE_ENV')   return nodeEnv;
    }),
  } as unknown as ConfigService;
  return new ChaosService(config);
}

describe('ChaosService', () => {
  // ── Enabled mode ──────────────────────────────────────────────────────────

  describe('when CHAOS_MODE=true (test env)', () => {
    let service: ChaosService;
    beforeEach(() => { service = makeService('true', 'test'); });

    it('should be enabled', () => {
      expect(service.isEnabled).toBe(true);
    });

    it('simulateRandomFailure at probability=1 should always throw ChaosError', async () => {
      await expect(service.simulateRandomFailure(1, 'test-label'))
        .rejects.toThrow(ChaosError);
    });

    it('simulateRandomFailure at probability=0 should never throw', async () => {
      await expect(service.simulateRandomFailure(0, 'test-label'))
        .resolves.toBeUndefined();
    });

    it('simulateRandomFailure should throw ChaosError (not generic Error)', async () => {
      await expect(service.simulateRandomFailure(1)).rejects.toBeInstanceOf(ChaosError);
    });

    it('simulateRandomFailure should throw on invalid probability > 1', async () => {
      await expect(service.simulateRandomFailure(1.5)).rejects.toThrow(Error);
      await expect(service.simulateRandomFailure(1.5)).rejects.not.toBeInstanceOf(ChaosError);
    });

    it('simulateRandomFailure should throw on invalid probability < 0', async () => {
      await expect(service.simulateRandomFailure(-0.1)).rejects.toThrow(Error);
    });

    it('simulateLatency should sleep approximately the right duration', async () => {
      jest.useFakeTimers();
      const promise = service.simulateLatency(500, 'test');
      jest.advanceTimersByTime(500);
      await expect(promise).resolves.toBeUndefined();
      jest.useRealTimers();
    });

    it('simulateLatency should throw on negative delay', async () => {
      await expect(service.simulateLatency(-100)).rejects.toThrow(Error);
    });

    it('simulateLatency with 0ms should resolve immediately', async () => {
      await expect(service.simulateLatency(0)).resolves.toBeUndefined();
    });
  });

  // ── Disabled mode (default) ───────────────────────────────────────────────

  describe('when CHAOS_MODE=false', () => {
    let service: ChaosService;
    beforeEach(() => { service = makeService('false', 'test'); });

    it('should be disabled', () => {
      expect(service.isEnabled).toBe(false);
    });

    it('simulateRandomFailure should always be a no-op', async () => {
      // Even at probability=1, disabled service never throws
      for (let i = 0; i < 10; i++) {
        await expect(service.simulateRandomFailure(1)).resolves.toBeUndefined();
      }
    });

    it('simulateLatency should be a no-op (no actual sleep)', async () => {
      const start = Date.now();
      await service.simulateLatency(10_000); // would be 10s if enabled
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);    // should return almost instantly
    });

    it('simulateChaos should be a no-op', async () => {
      await expect(service.simulateChaos('test', 1, 1)).resolves.toBeUndefined();
    });
  });

  // ── Production guard ──────────────────────────────────────────────────────

  describe('production safety guard', () => {
    it('should disable chaos even if CHAOS_MODE=true in production', () => {
      const service = makeService('true', 'production');
      expect(service.isEnabled).toBe(false);
    });
  });

  // ── ChaosError class ──────────────────────────────────────────────────────

  describe('ChaosError', () => {
    it('should have name=ChaosError', () => {
      const err = new ChaosError('test');
      expect(err.name).toBe('ChaosError');
    });

    it('should be instanceof Error', () => {
      expect(new ChaosError('x')).toBeInstanceOf(Error);
    });

    it('should carry the message', () => {
      expect(new ChaosError('boom').message).toBe('boom');
    });
  });
});
