import { BotModeService } from '../bot-mode.service';

describe('BotModeService', () => {
  let service: BotModeService;

  beforeEach(() => {
    service = new BotModeService();
  });

  it('generates template creatives and injects winner DNA hooks first', () => {
    const output = service.generateCreatives('Wireless Earbuds', 'electronics', 1999, [
      'Winner hook one',
      'Winner hook two',
    ]);

    expect(output.source).toBe('BOT_DNA');
    expect(output.hooks.slice(0, 2)).toEqual(['Winner hook one', 'Winner hook two']);
    expect(output.hooks).toHaveLength(3);
    expect(output.captions.length).toBeGreaterThan(0);
    expect(output.headlines.length).toBeGreaterThan(0);
  });

  it('holds when real revenue is missing', () => {
    const decision = service.makeHardRuleDecision(100, null, 2.5, 5000, 4);

    expect(decision.decision).toBe('HOLD');
    expect(decision.actions[0]).toEqual(
      expect.objectContaining({ type: 'WAIT_24H' }),
    );
  });

  it('kills campaigns with hard loss signals and scales profitable campaigns', () => {
    expect(service.makeHardRuleDecision(300, 1.2, 3, 4000, 0).decision).toBe('KILL');
    expect(service.makeHardRuleDecision(60, 2.3, 3, 4000, 5).decision).toBe('SCALE');
  });

  it('enters full bot mode after repeated API failures and recovers on success', () => {
    service.recordApiFailure('nvidia');
    service.recordApiFailure('meta');
    service.recordApiFailure('redis');

    expect(service.isInFullBotMode).toBe(true);
    expect(service.getStatus()).toEqual(
      expect.objectContaining({ isFullBotMode: true, failureCount: 3 }),
    );

    service.recordApiSuccess();
    expect(service.isInFullBotMode).toBe(false);
  });

  it('returns a valid unified fallback response for execute()', () => {
    const result = service.execute({
      operation: 'media',
      context: { title: 'Wireless Earbuds' },
    });

    const content = JSON.parse(result.content) as {
      operation: string;
      decision: string;
      rationale: string;
      timestamp: string;
    };
    expect(content.operation).toBe('media');
    expect(content.decision).toBe('HOLD');
    expect(content.rationale).toContain('Bot mode fallback');
    expect(Date.parse(content.timestamp)).not.toBeNaN();
  });
});
