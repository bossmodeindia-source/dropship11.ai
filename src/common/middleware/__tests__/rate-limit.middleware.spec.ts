import { HttpStatus } from '@nestjs/common';
import { RateLimitMiddleware } from '../rate-limit.middleware';

function makeRedis(counts: number[] = [1]): any {
  let call = 0;
  const pipeline = {
    incr: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockImplementation(async () => [
      [null, counts[Math.min(call++, counts.length - 1)]],
      [null, 1],
    ]),
  };
  return { pipeline: jest.fn().mockReturnValue(pipeline), _pipeline: pipeline };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const req = {
    path: '/api/v1/products',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as any;
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any;
  return { req, res, next: jest.fn() as jest.Mock };
}

describe('RateLimitMiddleware', () => {
  it('calls next when the IP is under its limit', async () => {
    const mw = new RateLimitMiddleware(makeRedis());
    const { req, res, next } = makeCtx();
    await mw.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets current IP limit headers', async () => {
    const mw = new RateLimitMiddleware(makeRedis([1]));
    const { req, res, next } = makeCtx();
    await mw.use(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-IP-Limit', '200');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-IP-Remaining', '199');
  });

  it('uses the first forwarded address as the IP key', async () => {
    const redis = makeRedis();
    const mw = new RateLimitMiddleware(redis);
    const { req, res, next } = makeCtx({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } });
    await mw.use(req, res, next);
    expect(redis._pipeline.incr.mock.calls[0][0]).toMatch(/^rl:ip:1\.2\.3\.4:/);
  });

  it('enforces the stricter authentication-route IP limit', async () => {
    const mw = new RateLimitMiddleware(makeRedis([11]));
    const { req, res, next } = makeCtx({ path: '/api/v1/auth/login' });
    await mw.use(req, res, next);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(next).not.toHaveBeenCalled();
  });

  it('applies a per-user plan limit after the IP layer', async () => {
    const redis = makeRedis([1, 61]);
    const mw = new RateLimitMiddleware(redis);
    const { req, res, next } = makeCtx({ userId: 'user-1', userPlan: 'free' });
    await mw.use(req, res, next);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(redis._pipeline.incr.mock.calls[1][0]).toMatch(/^rl:user:user-1:/);
  });

  it('applies the expensive-route limit for authenticated users', async () => {
    const redis = makeRedis([1, 1, 11]);
    const mw = new RateLimitMiddleware(redis);
    const { req, res, next } = makeCtx({
      path: '/api/v1/creative/generate', userId: 'user-1', userPlan: 'pro',
    });
    await mw.use(req, res, next);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Route-Limit', '10');
  });

  it('normalizes UUID route parameters before route lookup', async () => {
    const redis = makeRedis([1, 1]);
    const mw = new RateLimitMiddleware(redis);
    const { req, res, next } = makeCtx({
      path: '/api/v1/products/6ba7b810-9dad-11d1-80b4-00c04fd430c8', userId: 'user-1',
    });
    await mw.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns a standard 429 payload with Retry-After', async () => {
    const mw = new RateLimitMiddleware(makeRedis([201]));
    const { req, res, next } = makeCtx();
    await mw.use(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 429 }));
  });
});
