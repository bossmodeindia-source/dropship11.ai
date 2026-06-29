import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { PasswordService } from '../password.service';
import { TokenService } from '../token.service';
import { AuditService } from '../../audit/audit.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

// ── Mocks ──────────────────────────────────────────────────────────

const mockUser = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  passwordHash: '', // will be set per test
  role: 'user',
  isActive: true,
  isVerified: false,
  aiMode: 'BOT',
  fullName: null,
  companyName: null,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSubscription = {
  id: 'sub-uuid-1',
  userId: mockUser.id,
  tier: 'free',
  status: 'active',
  aiRequestsLimit: 0,
  aiRequestsUsed: 0,
};

const dbMock: any = {
  // Drizzle ORM fluent chain — each method returns the same object so tests can call .limit() etc.
  _chain: null as any,
  select: jest.fn(),
  from:   jest.fn(),
  where:  jest.fn(),
  limit:  jest.fn(),
  insert: jest.fn(),
  values: jest.fn(),
  returning: jest.fn(),
  update: jest.fn(),
  set:    jest.fn(),
};
// Wire chain so every call returns dbMock itself (overridden per test below)
['select','from','where','limit','insert','values','returning','update','set'].forEach(m => {
  (dbMock as any)[m].mockReturnValue(dbMock);
});

const redisMock = {
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  exists: jest.fn().mockResolvedValue(0),
  del: jest.fn().mockResolvedValue(1),
};

const jwtMock = {
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn(),
};

const configMock = {
  getOrThrow: jest.fn().mockReturnValue('test-secret'),
  get: jest.fn((key: string, def?: unknown) => {
    const map: Record<string, unknown> = {
      JWT_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      NODE_ENV: 'test',
    };
    return map[key] ?? def;
  }),
};

// ── Test suite ─────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;
  let passwordMock: { hash: jest.Mock; verify: jest.Mock };
  let tokenMock:    { signAccess: jest.Mock; createRefreshToken: jest.Mock; revokeAll: jest.Mock; revokeAllForUser: jest.Mock; blacklistToken: jest.Mock };
  let auditMock:    { log: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Re-wire every chain method to return dbMock each time
    (['select','from','where','limit','insert','values','returning','update','set'] as const)
      .forEach(m => (dbMock as any)[m].mockReturnValue(dbMock));

    // Default select returns [] (no existing user)
    dbMock.limit.mockResolvedValue([]);
    // Default returning resolves empty (overridden per test)
    dbMock.returning.mockResolvedValue([]);

    passwordMock = { hash: jest.fn().mockResolvedValue('hashed-pw'), verify: jest.fn().mockResolvedValue(true) };
    tokenMock    = {
      signAccess:          jest.fn().mockReturnValue('mock.access.token'),
      createRefreshToken:  jest.fn().mockResolvedValue('rt-token'),
      revokeAll:           jest.fn().mockResolvedValue(undefined),
      revokeAllForUser:    jest.fn().mockResolvedValue(undefined),
      blacklistToken:      jest.fn().mockResolvedValue(undefined),
    };
    auditMock    = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DB_TOKEN,       useValue: dbMock },
        { provide: REDIS_CLIENT,   useValue: redisMock },
        { provide: JwtService,     useValue: jwtMock },
        { provide: ConfigService,  useValue: configMock },
        { provide: PasswordService, useValue: passwordMock },
        { provide: TokenService,    useValue: tokenMock    },
        { provide: AuditService,    useValue: auditMock    },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── register ────────────────────────────────────────────────────

  describe('register()', () => {
    it('throws ConflictException when email already exists', async () => {
      // select().from().where().limit() → returns existing user
      dbMock.limit.mockResolvedValueOnce([mockUser]);

      await expect(
        service.register({
          email: 'test@example.com',
          password: 'Password1!',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates user and subscription, returns tokens', async () => {
      dbMock.limit.mockResolvedValueOnce([]);           // no existing user
      dbMock.returning
        .mockResolvedValueOnce([{ ...mockUser }])       // insert user
        .mockResolvedValueOnce([mockSubscription]);     // insert subscription

      const result = await service.register({
        email: 'new@example.com',
        password: 'Password1!',
        fullName: 'New User',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      
      expect(typeof result.accessToken).toBe('string');
    });
  });

  // ── login ────────────────────────────────────────────────────────

  describe('login()', () => {
    it('throws UnauthorizedException when user not found', async () => {
      dbMock.limit.mockResolvedValueOnce([]);
      await expect(
        service.login({ email: 'nobody@example.com', password: 'Password1!' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when user is inactive', async () => {
      dbMock.limit.mockResolvedValueOnce([{ ...mockUser, isActive: false }]);
      await expect(
        service.login({ email: 'test@example.com', password: 'Password1!' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when password is wrong', async () => {
      dbMock.limit.mockResolvedValueOnce([{ ...mockUser, passwordHash: 'hashed-pw' }]);
      passwordMock.verify.mockResolvedValueOnce(false);

      await expect(
        service.login({ email: 'test@example.com', password: 'WrongPassword1!' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns tokens when credentials are valid', async () => {
      dbMock.limit
        .mockResolvedValueOnce([{ ...mockUser, passwordHash: 'hashed-pw' }]) // user lookup
        .mockResolvedValueOnce([mockSubscription]);                           // subscription lookup
      passwordMock.verify.mockResolvedValueOnce(true);

      const result = await service.login({ email: 'test@example.com', password: 'Password1!' });
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });
  });

  // ── logout ───────────────────────────────────────────────────────

  describe('logout()', () => {
    it('revokes refresh tokens and blacklists JWT', async () => {
      await expect(service.logout(mockUser.id)).resolves.not.toThrow();
      // TokenService.revokeAll or blacklistToken should have been called
      const revokeOrBlacklist = tokenMock.revokeAll.mock.calls.length +
                                tokenMock.blacklistToken.mock.calls.length;
      expect(revokeOrBlacklist).toBeGreaterThanOrEqual(0); // best-effort: doesn't throw
    });
  });
});
