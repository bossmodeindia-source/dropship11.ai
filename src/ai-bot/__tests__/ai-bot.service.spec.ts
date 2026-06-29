import { Test, TestingModule } from '@nestjs/testing';
import { AiBotService, DispatchRequest } from '../ai-bot.service';
import { ToggleService } from '../toggle.service';
import { BotModeService } from '../modes/bot-mode.service';
import { DB_TOKEN } from '../../common/database/database.module';
import { AiOrchestratorService } from '../../ai-orchestrator/ai-orchestrator.service';

const mockOrchestratorResult = {
  content: { title: 'AI Title', tags: ['ai'] },
  source: 'NVIDIA_49B',
  usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
  latencyMs: 500,
};
const dbMock = {
  query: {
    subscriptions: {
      findFirst: jest.fn(),
    },
  },
};
const toggleMock = { getMode: jest.fn(), hasAiQuota: jest.fn(), consumeAiQuota: jest.fn() };
const orchestratorMock = {
  resolve: jest.fn().mockResolvedValue(mockOrchestratorResult),
  logUsage: jest.fn().mockResolvedValue(undefined),
};

const baseReq: DispatchRequest = { userId: 'user-1', operation: 'listing', context: { title: 'Product' } };

describe('AiBotService', () => {
  let service: AiBotService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiBotService,
        { provide: DB_TOKEN, useValue: dbMock },
        { provide: ToggleService, useValue: toggleMock },
        { provide: AiOrchestratorService, useValue: orchestratorMock },
      ],
    }).compile();
    service = module.get<AiBotService>(AiBotService);
  });

  describe('dispatch()', () => {
    it('delegates current requests through the AI orchestrator', async () => {
      dbMock.query.subscriptions.findFirst.mockResolvedValueOnce({ tier: 'pro' });

      const r = await service.dispatch(baseReq);

      expect(orchestratorMock.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          operation: 'listing',
          context: { title: 'Product' },
          userTier: 'pro',
        }),
      );
      expect(r.mode).toBe('AI');
      expect(r.content).toEqual({ title: 'AI Title', tags: ['ai'] });
    });

    it('uses the request user tier without querying subscriptions', async () => {
      await service.dispatch({ ...baseReq, userTier: 'enterprise' });

      expect(dbMock.query.subscriptions.findFirst).not.toHaveBeenCalled();
      expect(orchestratorMock.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ userTier: 'enterprise' }),
      );
    });

    it('maps cache and bot orchestrator sources to public modes', async () => {
      orchestratorMock.resolve
        .mockResolvedValueOnce({ ...mockOrchestratorResult, source: 'CACHE_L1' })
        .mockResolvedValueOnce({ ...mockOrchestratorResult, source: 'BOT' });

      await expect(service.dispatch(baseReq)).resolves.toMatchObject({ mode: 'CACHE' });
      await expect(service.dispatch(baseReq)).resolves.toMatchObject({ mode: 'BOT' });
    });

    it('logs usage asynchronously and includes usage in response', async () => {
      const r = await service.dispatch(baseReq);

      expect(orchestratorMock.logUsage).toHaveBeenCalledWith(
        'user-1',
        'listing',
        'NVIDIA_49B',
        mockOrchestratorResult.usage,
        500,
      );
      expect(r.usage?.totalTokens).toBe(300);
    });
  });

  describe('BotModeService unit', () => {
    let bot: BotModeService;
    beforeEach(() => { bot = new BotModeService(); });

    it('listing returns a safe fallback payload', () => {
      const r = bot.execute({ operation: 'listing', context: { title: 'Widget', category: 'Electronics', sellingPrice: 50, tags: [] } });
      const c = JSON.parse(r.content) as { operation: string; decision: string; rationale: string };
      expect(c.operation).toBe('listing');
      expect(c.decision).toBe('HOLD');
      expect(c.rationale).toContain('Bot mode fallback');
    });

    it('campaign returns a safe fallback payload', () => {
      const r = bot.execute({ operation: 'campaign', context: { title: 'Widget', sellingPrice: 25, decision: 'RUN_ADS' } });
      const c = JSON.parse(r.content) as { operation: string; decision: string; timestamp: string };
      expect(c.operation).toBe('campaign');
      expect(c.decision).toBe('HOLD');
      expect(new Date(c.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('scoring returns a safe fallback payload', () => {
      const r = bot.execute({ operation: 'scoring', context: { supplierPrice: 10, sellingPrice: 30 } });
      const c = JSON.parse(r.content) as { operation: string; decision: string; rationale: string };
      expect(c.operation).toBe('scoring');
      expect(c.decision).toBe('HOLD');
      expect(c.rationale).toContain('no live AI available');
    });
  });
});
