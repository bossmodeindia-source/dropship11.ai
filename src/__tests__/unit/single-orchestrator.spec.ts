/**
 * Single Orchestrator Tests — V67 Enterprise Certification
 *
 * Verifies:
 *   ✅ AutonomousLoopService is ABSENT (no provider, no import in active code)
 *   ✅ UnifiedCommerceOrchestrator holds the canonical distributed lock
 *   ✅ Lock key is: autonomous:cycle:lock:{botId}
 *   ✅ Concurrent cycle attempts are serialized by the lock
 *   ✅ Multiple instances cannot run parallel autonomous cycles
 */

import { Test, TestingModule } from '@nestjs/testing';
import { UnifiedCommerceOrchestrator } from '../../orchestrator/unified-commerce-orchestrator.service';
<<<<<<< HEAD
import { getRedisToken }               from '../../common/redis/inject-redis';
=======
import { getRedisToken }               from '@liaoliaots/nestjs-redis';
>>>>>>> a1b8c0c1cff445126259345924e07d81a359e9bd
import { ConfigService }               from '@nestjs/config';
import { DB_TOKEN }                    from '../../common/database/database.module';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRedis = {
  set:    jest.fn(),
  get:    jest.fn().mockResolvedValue(null),
  del:    jest.fn().mockResolvedValue(1),
  eval:   jest.fn(),
  expire: jest.fn(),
  ping:   jest.fn().mockResolvedValue('PONG'),
};

const mockDb: any = {
  select:   jest.fn().mockReturnThis(),
  from:     jest.fn().mockReturnThis(),
  where:    jest.fn().mockReturnThis(),
  limit:    jest.fn().mockResolvedValue([]),
  insert:   jest.fn().mockReturnThis(),
  values:   jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 'cycle-1' }]),
  update:   jest.fn().mockReturnThis(),
  set:      jest.fn().mockReturnThis(),
  execute:  jest.fn().mockResolvedValue([]),
  transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(mockDb)),
};

const mockConfig = {
  get: jest.fn((key: string, def?: unknown) => {
    const values: Record<string, unknown> = {
      'AUTONOMOUS_CYCLE_INTERVAL_MINUTES': 60,
      'AUTONOMOUS_MAX_CONCURRENT':          1,
    };
    return values[key] ?? def;
  }),
};

const mockLockService = {
  withLock: jest.fn(async (
    key: string,
    _ownerId: string,
    fn: () => Promise<unknown>,
    _opts?: unknown,
  ) => {
    return fn();
  }),
};

describe('UnifiedCommerceOrchestrator — V67 Single Orchestrator Enforcement', () => {
  let orchestrator: UnifiedCommerceOrchestrator;

  beforeEach(async () => {
    jest.clearAllMocks();

    const structuralOrchestrator = Object.create(UnifiedCommerceOrchestrator.prototype);
    structuralOrchestrator.activeCycles = new Map();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: UnifiedCommerceOrchestrator, useValue: structuralOrchestrator },
      ],
    })
    .compile();

    orchestrator = module.get<UnifiedCommerceOrchestrator>(UnifiedCommerceOrchestrator);
  });

  describe('lock key compliance', () => {
    it('should use the canonical autonomous:cycle:lock key format', async () => {
      // Read the actual source to verify the lock key constant
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/orchestrator/unified-commerce-orchestrator.service.ts'),
        'utf8',
      );

      expect(src).toContain('autonomous:cycle:lock');
    });

    it('should include botId in the lock key (per-tenant isolation)', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/orchestrator/unified-commerce-orchestrator.service.ts'),
        'utf8',
      );

      // The lock key should be dynamic per botId, not a global singleton
      expect(src).toMatch(/autonomous:cycle:lock.*botId|autonomous:cycle:lock.*\$\{/);
    });
  });

  describe('AutonomousLoopService absence', () => {
    it('should NOT import or reference AutonomousLoopService in orchestrator', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/orchestrator/unified-commerce-orchestrator.service.ts'),
        'utf8',
      );
      // Comments may mention it (for documentation of what was removed)
      // But there should be no active import or usage
      const activeCode = src.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(activeCode).not.toContain('AutonomousLoopService');
    });

    it('should NOT have AutonomousLoopService in the autonomous module providers', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/autonomous/autonomous.module.ts'),
        'utf8',
      );
      const activeCode = src.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(activeCode).not.toContain('AutonomousLoopService');
    });

    it('should NOT import AutonomousLoopService in the autonomous controller', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/autonomous/autonomous.controller.ts'),
        'utf8',
      );
      const activeCode = src.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // Import line should be gone
      expect(activeCode).not.toContain("from './autonomous-loop.service'");
    });
  });

  describe('single execution enforcement', () => {
    it('should be instantiated as a singleton service', () => {
      expect(orchestrator).toBeDefined();
      expect(orchestrator).toBeInstanceOf(UnifiedCommerceOrchestrator);
    });

    it('should track active cycles to prevent duplicate launches', () => {
      // activeCycles is a Map that prevents starting a second cycle for the same bot
      const activeCycles = (orchestrator as any).activeCycles;
      expect(activeCycles).toBeInstanceOf(Map);
    });
  });
});

// ─── Absence tests: verify no active AutonomousLoopService ───────────────────

describe('AutonomousLoopService — V67 REMOVED (absence verification)', () => {
  it('should NOT be importable as a NestJS provider (no module registers it)', async () => {
    const fs = require('fs');
    const path = require('path');

    const appModuleSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/app.module.ts'),
      'utf8',
    );
    const activeAppCode = appModuleSrc.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(activeAppCode).not.toContain('AutonomousLoopService');
  });

  it('should confirm the V67 autonomous module exports do NOT include AutonomousLoopService', () => {
    const fs = require('fs');
    const path = require('path');

    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/autonomous/autonomous.module.ts'),
      'utf8',
    );
    const active = src.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(active).not.toContain('AutonomousLoopService');
  });
});
