import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitMiddleware } from '../../../middleware/rate-limit.middleware';
import { EncryptionService } from '../../../crypto/encryption.service';

function makeRedisWithCounter() {
  const store = new Map<string, number>();
  const redis = {
    pipeline: jest.fn().mockImplementation(() => {
      let key = '';
      return {
        incr: jest.fn().mockImplementation((nextKey: string) => { key = nextKey; return this; }),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockImplementation(async () => {
          const count = (store.get(key) ?? 0) + 1;
          store.set(key, count);
          return [[null, count], [null, 1]];
        }),
      };
    }),
  } as any;
  return { redis, store };
}

function makeReq(ip: string, path = '/api/v1/auth/login', userId?: string) {
  return {
    path,
    headers: {},
    socket: { remoteAddress: ip },
    userId,
    userPlan: 'free',
  } as any;
}

function makeRes() {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any;
}

describe('Security Hardening Tests', () => {
  describe('Brute-force protection', () => {
    it('blocks an IP after the authentication-route threshold', async () => {
      const { redis } = makeRedisWithCounter();
      const mw = new RateLimitMiddleware(redis);
      let blocked = false;
      for (let attempt = 1; attempt <= 11; attempt++) {
        const res = makeRes();
        await mw.use(makeReq('10.0.0.1'), res, jest.fn());
        blocked ||= res.status.mock.calls.some(([status]: [number]) => status === HttpStatus.TOO_MANY_REQUESTS);
      }
      expect(blocked).toBe(true);
    });

    it('keeps counters isolated by IP', async () => {
      const { redis } = makeRedisWithCounter();
      const mw = new RateLimitMiddleware(redis);
      for (let i = 0; i < 11; i++) await mw.use(makeReq('attacker-ip'), makeRes(), jest.fn());
      const next = jest.fn();
      await mw.use(makeReq('good-user-ip'), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('Rate limit bypass prevention', () => {
    it('uses the first forwarded address consistently', async () => {
      const { redis, store } = makeRedisWithCounter();
      const mw = new RateLimitMiddleware(redis);
      const req = makeReq('1.2.3.4');
      req.headers = { 'x-forwarded-for': '8.8.8.8, 9.9.9.9' };
      await mw.use(req, makeRes(), jest.fn());
      expect([...store.keys()][0]).toMatch(/^rl:ip:8\.8\.8\.8:/);
    });

    it('adds an independent user counter for authenticated requests', async () => {
      const { redis, store } = makeRedisWithCounter();
      const mw = new RateLimitMiddleware(redis);
      await mw.use(makeReq('1.2.3.4', '/api/v1/orders', 'authenticated-user'), makeRes(), jest.fn());
      expect([...store.keys()].some(key => key.startsWith('rl:user:authenticated-user:'))).toBe(true);
    });
  });

  describe('Encrypted token security', () => {
    let enc: EncryptionService;

    beforeEach(() => {
      enc = new EncryptionService({
        get: jest.fn().mockReturnValue('security-test-master-key-that-is-long-enough!!'),
      } as unknown as ConfigService);
    });

    it('rejects a replayed token after key rotation', () => {
      const oldEnc = new EncryptionService({
        get: jest.fn().mockReturnValue('old-master-key-that-is-at-least-32chars!!'),
      } as unknown as ConfigService);
      expect(() => enc.decrypt(oldEnc.encrypt('shpat_old_token'))).toThrow();
    });

    it('rejects a token with a flipped ciphertext bit', () => {
      const buf = Buffer.from(enc.encrypt('shpat_genuine_token'), 'base64url');
      buf[28] ^= 0x01;
      expect(() => enc.decrypt(buf.toString('base64url'))).toThrow();
    });

    it('round-trips valid tokens', () => {
      const token = 'shpat_valid_token';
      expect(enc.decrypt(enc.encrypt(token))).toBe(token);
    });
  });
});
