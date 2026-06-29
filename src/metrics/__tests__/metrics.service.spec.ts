import { MetricsService } from '../metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
    service.onModuleInit();
  });

  it('initialises without error', () => {
    expect(service).toBeDefined();
    expect(service.registry).toBeDefined();
  });

  it('getMetrics() returns a non-empty string', async () => {
    const output = await service.getMetrics();
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('dropship_');
  });

  it('contentType() returns prometheus content type', () => {
    expect(service.contentType()).toContain('text/plain');
  });

  it('recordHttpRequest() increments counter', async () => {
    service.recordHttpRequest('GET', '/api/v1/products', 200, 45);
    const output = await service.getMetrics();
    expect(output).toContain('dropship_http_requests_total');
  });

  it('recordOrderReceived() increments counter', async () => {
    service.recordOrderReceived('shopify');
    const output = await service.getMetrics();
    expect(output).toContain('dropship_orders_received_total');
  });

  it('recordOrderFulfilled() increments counter and records histogram', async () => {
    service.recordOrderFulfilled('mock', 8500);
    const output = await service.getMetrics();
    expect(output).toContain('dropship_orders_fulfilled_total');
    expect(output).toContain('dropship_order_fulfillment_duration_seconds');
  });

  it('recordOrderFailed() increments counter', async () => {
    service.recordOrderFailed('mock');
    const output = await service.getMetrics();
    expect(output).toContain('dropship_orders_failed_total');
  });

  it('updateQueueDepth() sets gauge values', async () => {
    service.updateQueueDepth(5, 2, 1, 0);
    const output = await service.getMetrics();
    expect(output).toContain('dropship_order_queue_depth');
  });

  it('recordProductDecision() increments both counters', async () => {
    service.recordProductDecision('RUN_ADS');
    service.recordProductDecision('REJECT');
    const output = await service.getMetrics();
    expect(output).toContain('dropship_products_scored_total');
    expect(output).toContain('dropship_product_decisions_total');
  });

  it('recordAiDispatch() records tokens and duration', async () => {
    service.recordAiDispatch('AI', 'listing', 350, 'gpt-4o-mini', 1200);
    const output = await service.getMetrics();
    expect(output).toContain('dropship_ai_requests_total');
    expect(output).toContain('dropship_ai_tokens_total');
    expect(output).toContain('dropship_ai_request_duration_seconds');
  });
});
