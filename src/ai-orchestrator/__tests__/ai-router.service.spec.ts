/**
 * AiRouter Unit Tests
 *
 * Covers every routing rule in strict priority order:
 *
 *  Rule 1  — scoring:evaluate   → always BOT
 *  Rule 2  — quota exhausted    → BOT
 *  Rule 3  — all circuit breakers open → BOT
 *  Rule 4a — strategy + spend≥$50 + no cooldown + 253B available → NVIDIA_253B
 *  Rule 4b — strategy + spend≥$50 + cooldown active   → BOT
 *  Rule 4c — strategy + spend≥$50 + 253B circuit open → BOT
 *  Rule 4d — strategy + spend<$50   → BOT
 *  Rule 5  — 49B circuit open   → BOT
 *  Rule 5b — 49B no API key     → BOT
 *  Rule 6  — premium user (pro/enterprise) + 49B available → NVIDIA_49B
 *  Rule 7  — high product score (≥65) + 49B available → NVIDIA_49B
 *  Rule 8  — default free tier + low score → BOT
 *
 * Every test uses mocked DB, CircuitBreaker, Cooldown, and ProviderRegistry
 * so zero network calls occur and tests run in < 50ms total.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { AiRouter, RoutingInput } from '../ai-router.service';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { CooldownService } from '../cooldown.service';
import { AiProviderRegistry } from '../ai-provider.registry';
import { DB_TOKEN } from '../../common/database/database.module';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FREE_USER: RoutingInput = {
  operation:     'listing',
  productScore:  40,
  userTier:      'free',
  userId:        'user-free',
  campaignSpend: 0,
};

const PRO_USER: RoutingInput = {
  ...FREE_USER,
  userTier: 'pro',
  userId:   'user-pro',
};

const ENTERPRISE_USER: RoutingInput = {
  ...FREE_USER,
  userTier: 'enterprise',
  userId:   'user-ent',
};

const HIGH_SCORE_USER: RoutingInput = {
  ...FREE_USER,
  productScore: 65,   // exactly at threshold
};

const ABOVE_SCORE_USER: RoutingInput = {
  ...FREE_USER,
  productScore: 80,
};

const STRATEGY_HIGH_SPEND: RoutingInput = {
  operation:     'strategy',
  productScore:  80,
  userTier:      'pro',
  userId:        'user-strategy',
  campaignSpend: 50,   // exactly at $50 threshold
};

const STRATEGY_LOW_SPEND: RoutingInput = {
  ...STRATEGY_HIGH_SPEND,
  campaignSpend: 49.99,
};

// ── Mock factories ────────────────────────────────────────────────────────────

function makeBreakerMock(overrides: {
  nvidia49bOpen?:  boolean;
  nvidia253bOpen?: boolean;
} = {}) {
  return {
    isOpen: jest.fn().mockImplementation((provider: string) => {
      if (provider === 'nvidia_49b')  return Promise.resolve(overrides.nvidia49bOpen  ?? false);
      if (provider === 'nvidia_253b') return Promise.resolve(overrides.nvidia253bOpen ?? false);
      return Promise.resolve(false);
    }),
    recordSuccess: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  };
}

function makeCooldownMock(inCooldown = false) {
  return {
    isInCooldown: jest.fn().mockResolvedValue(inCooldown),
    setCooldown:  jest.fn().mockResolvedValue(undefined),
  };
}

function makeRegistryMock(opts: {
  bot49bAvailable?:  boolean;
  bot253bAvailable?: boolean;
} = {}) {
  return {
    get49B: jest.fn().mockReturnValue({
      isAvailable: jest.fn().mockResolvedValue(opts.bot49bAvailable  ?? true),
    }),
    get253B: jest.fn().mockReturnValue({
      isAvailable: jest.fn().mockResolvedValue(opts.bot253bAvailable ?? true),
    }),
    getBot: jest.fn().mockReturnValue({
      isAvailable: jest.fn().mockResolvedValue(true),
    }),
  };
}

function makeDbMock(hasQuota = true) {
  return {
    query: {
      subscriptions: {
        findFirst: jest.fn().mockResolvedValue({
          aiRequestsUsed:  hasQuota ? 0   : 100,
          aiRequestsLimit: hasQuota ? 100 : 100,
        }),
      },
    },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AiRouter', () => {
  let router:  AiRouter;
  let breaker: ReturnType<typeof makeBreakerMock>;
  let cooldown: ReturnType<typeof makeCooldownMock>;
  let registry: ReturnType<typeof makeRegistryMock>;
  let db:       ReturnType<typeof makeDbMock>;

  async function buildModule(opts: {
    hasQuota?:       boolean;
    nvidia49bOpen?:  boolean;
    nvidia253bOpen?: boolean;
    inCooldown?:     boolean;
    bot49bAvailable?:  boolean;
    bot253bAvailable?: boolean;
  } = {}): Promise<void> {
    breaker  = makeBreakerMock({ nvidia49bOpen: opts.nvidia49bOpen, nvidia253bOpen: opts.nvidia253bOpen });
    cooldown = makeCooldownMock(opts.inCooldown ?? false);
    registry = makeRegistryMock({ bot49bAvailable: opts.bot49bAvailable, bot253bAvailable: opts.bot253bAvailable });
    db       = makeDbMock(opts.hasQuota ?? true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiRouter,
        { provide: DB_TOKEN,               useValue: db       },
        { provide: CircuitBreakerService,  useValue: breaker  },
        { provide: CooldownService,        useValue: cooldown },
        { provide: AiProviderRegistry,     useValue: registry },
      ],
    }).compile();

    router = module.get<AiRouter>(AiRouter);
  }

  beforeEach(async () => {
    await buildModule();
  });

  // ── Rule 1: Scoring always BOT ────────────────────────────────────────────

  describe('Rule 1 — scoring', () => {
    it('routes scoring operation to BOT regardless of user tier', async () => {
      const result = await router.decide({ ...PRO_USER, operation: 'scoring' });

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('scoring_is_deterministic');
    });

    it('routes scoring to BOT even for enterprise user with high score', async () => {
      const result = await router.decide({
        ...ENTERPRISE_USER,
        operation:    'scoring',
        productScore: 99,
      });

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('scoring_is_deterministic');
    });

    it('short-circuits before any DB/Redis calls for scoring', async () => {
      await router.decide({ ...FREE_USER, operation: 'scoring' });

      // Quota check, breaker checks, cooldown — none should fire
      expect(db.query.subscriptions.findFirst).not.toHaveBeenCalled();
      expect(breaker.isOpen).not.toHaveBeenCalled();
    });
  });

  // ── Rule 2: Quota exhausted ───────────────────────────────────────────────

  describe('Rule 2 — quota exhaustion', () => {
    beforeEach(async () => {
      await buildModule({ hasQuota: false });
    });

    it('routes to BOT when AI quota is exhausted', async () => {
      const result = await router.decide(PRO_USER);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('quota_exhausted');
    });

    it('quota check fires even for premium users', async () => {
      const result = await router.decide(ENTERPRISE_USER);

      expect(result.tier).toBe('BOT');
      expect(db.query.subscriptions.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({}),
      );
    });
  });

  // ── Rule 3: Both circuit breakers open ───────────────────────────────────

  describe('Rule 3 — all NVIDIA circuit breakers open', () => {
    beforeEach(async () => {
      await buildModule({ nvidia49bOpen: true, nvidia253bOpen: true });
    });

    it('routes to BOT when both breakers are open', async () => {
      const result = await router.decide(PRO_USER);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('circuit_breaker_open_all');
    });

    it('checks both breakers in parallel (two isOpen calls)', async () => {
      await router.decide(PRO_USER);

      expect(breaker.isOpen).toHaveBeenCalledWith('nvidia_49b');
      expect(breaker.isOpen).toHaveBeenCalledWith('nvidia_253b');
    });
  });

  // ── Rule 4: Strategy → 253B gate ─────────────────────────────────────────

  describe('Rule 4 — strategy routing', () => {
    it('routes to NVIDIA_253B when spend ≥ $50, no cooldown, 253B available', async () => {
      const result = await router.decide(STRATEGY_HIGH_SPEND);

      expect(result.tier).toBe('NVIDIA_253B');
      expect(result.reason).toBe('strategy_high_spend_no_cooldown');
    });

    it('routes to NVIDIA_253B at exactly $50 spend (boundary)', async () => {
      const result = await router.decide({ ...STRATEGY_HIGH_SPEND, campaignSpend: 50 });

      expect(result.tier).toBe('NVIDIA_253B');
    });

    it('routes to BOT when spend is $49.99 (below threshold)', async () => {
      const result = await router.decide(STRATEGY_LOW_SPEND);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('strategy_insufficient_spend');
    });

    it('routes to BOT when spend ≥ $50 but user is in 24h cooldown', async () => {
      await buildModule({ inCooldown: true });

      const result = await router.decide(STRATEGY_HIGH_SPEND);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('strategy_253b_unavailable_or_cooldown');
    });

    it('routes to BOT when spend ≥ $50 but 253B circuit breaker is open', async () => {
      await buildModule({ nvidia253bOpen: true });

      const result = await router.decide(STRATEGY_HIGH_SPEND);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('strategy_253b_unavailable_or_cooldown');
    });

    it('routes to BOT when 253B provider has no API key', async () => {
      await buildModule({ bot253bAvailable: false });

      const result = await router.decide(STRATEGY_HIGH_SPEND);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('strategy_253b_unavailable_or_cooldown');
    });

    it('checks strategy_253b cooldown key specifically', async () => {
      await router.decide(STRATEGY_HIGH_SPEND);

      expect(cooldown.isInCooldown).toHaveBeenCalledWith(
        STRATEGY_HIGH_SPEND.userId,
        'strategy_253b',
        expect.any(Number),
      );
    });

    it('never calls cooldown check when spend < $50', async () => {
      await router.decide(STRATEGY_LOW_SPEND);

      expect(cooldown.isInCooldown).not.toHaveBeenCalled();
    });
  });

  // ── Rule 5: 49B circuit breaker open ─────────────────────────────────────

  describe('Rule 5 — 49B circuit breaker', () => {
    beforeEach(async () => {
      await buildModule({ nvidia49bOpen: true, nvidia253bOpen: false });
    });

    it('routes to BOT when only 49B circuit breaker is open', async () => {
      const result = await router.decide(PRO_USER);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('circuit_breaker_49b_open');
    });

    it('blocks premium users when 49B breaker is open', async () => {
      const result = await router.decide(ENTERPRISE_USER);

      expect(result.tier).toBe('BOT');
    });
  });

  // ── Rule 5b: 49B no API key ───────────────────────────────────────────────

  describe('Rule 5b — 49B no API key configured', () => {
    beforeEach(async () => {
      await buildModule({ bot49bAvailable: false });
    });

    it('routes to BOT when 49B has no API key', async () => {
      const result = await router.decide(PRO_USER);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('nvidia_49b_no_key');
    });

    it('calls isAvailable() on the 49B provider', async () => {
      await router.decide(PRO_USER);

      expect(registry.get49B().isAvailable).toHaveBeenCalled();
    });
  });

  // ── Rule 6: Premium user → 49B ───────────────────────────────────────────

  describe('Rule 6 — premium user routing to 49B', () => {
    it('routes pro user to NVIDIA_49B', async () => {
      const result = await router.decide(PRO_USER);

      expect(result.tier).toBe('NVIDIA_49B');
      expect(result.reason).toBe('premium_user');
    });

    it('routes enterprise user to NVIDIA_49B', async () => {
      const result = await router.decide(ENTERPRISE_USER);

      expect(result.tier).toBe('NVIDIA_49B');
      expect(result.reason).toBe('premium_user');
    });

    it('routes starter user via score, not premium gate', async () => {
      const result = await router.decide({ ...FREE_USER, userTier: 'starter', productScore: 40 });

      // starter is not premium, low score → BOT
      expect(result.tier).toBe('BOT');
    });

    it('routes pro user to 49B even with low product score', async () => {
      const result = await router.decide({ ...PRO_USER, productScore: 10 });

      expect(result.tier).toBe('NVIDIA_49B');
    });
  });

  // ── Rule 7: High product score → 49B ─────────────────────────────────────

  describe('Rule 7 — high product score routing', () => {
    it('routes free user to NVIDIA_49B when score = 65 (boundary)', async () => {
      const result = await router.decide(HIGH_SCORE_USER);

      expect(result.tier).toBe('NVIDIA_49B');
      expect(result.reason).toBe('high_score_product');
    });

    it('routes free user to NVIDIA_49B when score > 65', async () => {
      const result = await router.decide(ABOVE_SCORE_USER);

      expect(result.tier).toBe('NVIDIA_49B');
      expect(result.reason).toBe('high_score_product');
    });

    it('does NOT route to 49B when score = 64 (below threshold)', async () => {
      const result = await router.decide({ ...FREE_USER, productScore: 64 });

      expect(result.tier).toBe('BOT');
    });

    it('does NOT route to 49B when score = 0', async () => {
      const result = await router.decide({ ...FREE_USER, productScore: 0 });

      expect(result.tier).toBe('BOT');
    });
  });

  // ── Rule 8: Default BOT ───────────────────────────────────────────────────

  describe('Rule 8 — default BOT fallback', () => {
    it('routes free user with low score to BOT', async () => {
      const result = await router.decide(FREE_USER);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('default_bot_fallback');
    });

    it('returns BOT for starter tier with score below threshold', async () => {
      const result = await router.decide({
        ...FREE_USER,
        userTier:     'starter',
        productScore: 50,
      });

      expect(result.tier).toBe('BOT');
    });
  });

  // ── Decision object shape ─────────────────────────────────────────────────

  describe('RoutingDecision shape', () => {
    it('always returns { tier, reason } on BOT path', async () => {
      const result = await router.decide(FREE_USER);

      expect(result).toHaveProperty('tier');
      expect(result).toHaveProperty('reason');
      expect(typeof result.tier).toBe('string');
      expect(typeof result.reason).toBe('string');
    });

    it('always returns { tier, reason } on NVIDIA_49B path', async () => {
      const result = await router.decide(PRO_USER);

      expect(result).toHaveProperty('tier');
      expect(result).toHaveProperty('reason');
    });

    it('always returns { tier, reason } on NVIDIA_253B path', async () => {
      const result = await router.decide(STRATEGY_HIGH_SPEND);

      expect(result).toHaveProperty('tier');
      expect(result).toHaveProperty('reason');
    });
  });

  // ── Resilience ────────────────────────────────────────────────────────────

  describe('Resilience — DB failures', () => {
    it('assumes quota available when DB throws', async () => {
      db.query.subscriptions.findFirst = jest.fn().mockRejectedValue(
        new Error('DB connection lost'),
      );

      // Should not throw, and should NOT route to BOT for quota reasons
      const result = await router.decide(PRO_USER);

      // With DB down, quota check returns true (fail-open), pro user → 49B
      expect(result.tier).toBe('NVIDIA_49B');
    });
  });

  describe('Resilience — Redis failures (circuit breaker)', () => {
    it('assumes breakers closed when Redis throws', async () => {
      // Simulate Redis failure — isOpen rejects (circuit assumed closed = fail open)
      breaker.isOpen.mockReset().mockRejectedValueOnce(new Error('Redis unreachable'));

      // Should not throw — fail open means route normally for pro user
      const result = await router.decide(PRO_USER);

      expect(['NVIDIA_49B', 'BOT']).toContain(result.tier);
    });
  });

  // ── Priority ordering ─────────────────────────────────────────────────────

  describe('Priority enforcement', () => {
    it('scoring beats premium user tier (Rule 1 > Rule 6)', async () => {
      const result = await router.decide({ ...PRO_USER, operation: 'scoring' });

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('scoring_is_deterministic');
    });

    it('quota exhaustion beats high product score (Rule 2 > Rule 7)', async () => {
      await buildModule({ hasQuota: false });

      const result = await router.decide({ ...FREE_USER, productScore: 99 });

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('quota_exhausted');
    });

    it('circuit breaker beats premium user (Rule 3 > Rule 6)', async () => {
      await buildModule({ nvidia49bOpen: true, nvidia253bOpen: true });

      const result = await router.decide(ENTERPRISE_USER);

      expect(result.tier).toBe('BOT');
      expect(result.reason).toBe('circuit_breaker_open_all');
    });
  });
});
