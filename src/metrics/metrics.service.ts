import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry: Registry;

  // ── HTTP metrics ─────────────────────────────────────────────────
  readonly httpRequestsTotal: Counter<string>;
  readonly httpRequestDuration: Histogram<string>;

  // ── Order metrics ────────────────────────────────────────────────
  readonly ordersReceived: Counter<string>;
  readonly ordersFulfilled: Counter<string>;
  readonly ordersFailed: Counter<string>;
  readonly orderQueueDepth: Gauge<string>;
  readonly orderFulfillmentDuration: Histogram<string>;

  // ── Product metrics ──────────────────────────────────────────────
  readonly productsScored: Counter<string>;
  readonly productDecisions: Counter<string>;

  // ── AI/BOT metrics ───────────────────────────────────────────────
  readonly aiRequestsTotal: Counter<string>;
  readonly aiTokensConsumed: Counter<string>;
  readonly aiRequestDuration: Histogram<string>;

  // ── Auth metrics ─────────────────────────────────────────────────
  readonly authLoginTotal: Counter<string>;
  readonly authLoginFailures: Counter<string>;

  constructor() {
    this.registry = new Registry();

    // Default Node.js metrics (heap, GC, event loop lag, etc.)
    collectDefaultMetrics({ register: this.registry, prefix: 'dropship_' });

    // ── HTTP ─────────────────────────────────────────────────────
    this.httpRequestsTotal = new Counter({
      name: 'dropship_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'dropship_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // ── Orders ───────────────────────────────────────────────────
    this.ordersReceived = new Counter({
      name: 'dropship_orders_received_total',
      help: 'Total webhook orders received',
      labelNames: ['platform'],
      registers: [this.registry],
    });

    this.ordersFulfilled = new Counter({
      name: 'dropship_orders_fulfilled_total',
      help: 'Total orders fulfilled by supplier',
      labelNames: ['supplier_type'],
      registers: [this.registry],
    });

    this.ordersFailed = new Counter({
      name: 'dropship_orders_failed_total',
      help: 'Total orders that failed after all retries',
      labelNames: ['supplier_type'],
      registers: [this.registry],
    });

    this.orderQueueDepth = new Gauge({
      name: 'dropship_order_queue_depth',
      help: 'Current BullMQ order queue depth',
      labelNames: ['state'],
      registers: [this.registry],
    });

    this.orderFulfillmentDuration = new Histogram({
      name: 'dropship_order_fulfillment_duration_seconds',
      help: 'End-to-end order fulfillment duration',
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });

    // ── Products ─────────────────────────────────────────────────
    this.productsScored = new Counter({
      name: 'dropship_products_scored_total',
      help: 'Total products scored',
      registers: [this.registry],
    });

    this.productDecisions = new Counter({
      name: 'dropship_product_decisions_total',
      help: 'Product decisions by type',
      labelNames: ['decision'],
      registers: [this.registry],
    });

    // ── AI/BOT ───────────────────────────────────────────────────
    this.aiRequestsTotal = new Counter({
      name: 'dropship_ai_requests_total',
      help: 'Total AI/BOT dispatch requests',
      labelNames: ['mode', 'operation'],
      registers: [this.registry],
    });

    this.aiTokensConsumed = new Counter({
      name: 'dropship_ai_tokens_total',
      help: 'Total AI tokens consumed',
      labelNames: ['model'],
      registers: [this.registry],
    });

    this.aiRequestDuration = new Histogram({
      name: 'dropship_ai_request_duration_seconds',
      help: 'AI request latency',
      labelNames: ['mode', 'operation'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30],
      registers: [this.registry],
    });

    // ── Auth ─────────────────────────────────────────────────────
    this.authLoginTotal = new Counter({
      name: 'dropship_auth_login_total',
      help: 'Total login attempts',
      registers: [this.registry],
    });

    this.authLoginFailures = new Counter({
      name: 'dropship_auth_login_failures_total',
      help: 'Total failed login attempts',
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    // Pre-initialize known label combinations to avoid sparse metrics
    this.productDecisions.labels({ decision: 'RUN_ADS' });
    this.productDecisions.labels({ decision: 'TEST_ADS' });
    this.productDecisions.labels({ decision: 'REJECT' });
    this.aiRequestsTotal.labels({ mode: 'AI', operation: 'listing' });
    this.aiRequestsTotal.labels({ mode: 'BOT', operation: 'listing' });
    this.orderQueueDepth.labels({ state: 'waiting' }).set(0);
    this.orderQueueDepth.labels({ state: 'active' }).set(0);
    this.orderQueueDepth.labels({ state: 'failed' }).set(0);
    this.orderQueueDepth.labels({ state: 'dlq' }).set(0);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  // ── Convenience recorders ────────────────────────────────────────

  recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestsTotal.labels(labels).inc();
    this.httpRequestDuration.labels(labels).observe(durationMs / 1000);
  }

  recordOrderReceived(platform: string): void {
    this.ordersReceived.labels({ platform }).inc();
  }

  recordOrderFulfilled(supplierType: string, durationMs: number): void {
    this.ordersFulfilled.labels({ supplier_type: supplierType }).inc();
    this.orderFulfillmentDuration.observe(durationMs / 1000);
  }

  recordOrderFailed(supplierType: string): void {
    this.ordersFailed.labels({ supplier_type: supplierType }).inc();
  }

  updateQueueDepth(waiting: number, active: number, failed: number, dlq: number): void {
    this.orderQueueDepth.labels({ state: 'waiting' }).set(waiting);
    this.orderQueueDepth.labels({ state: 'active' }).set(active);
    this.orderQueueDepth.labels({ state: 'failed' }).set(failed);
    this.orderQueueDepth.labels({ state: 'dlq' }).set(dlq);
  }

  recordProductDecision(decision: string): void {
    this.productsScored.inc();
    this.productDecisions.labels({ decision }).inc();
  }

  recordAiDispatch(mode: string, operation: string, tokens: number, model: string, durationMs: number): void {
    this.aiRequestsTotal.labels({ mode, operation }).inc();
    this.aiTokensConsumed.labels({ model }).inc(tokens);
    this.aiRequestDuration.labels({ mode, operation }).observe(durationMs / 1000);
  }

  /** Generic counter increment for ad-hoc metrics. Creates or reuses a counter by name. */
  incrementCounter(name: string, labels?: Record<string, string>): void {
    if (!this._adhocCounters) this._adhocCounters = new Map();
    if (!this._adhocCounters.has(name)) {
      const labelNames = labels ? Object.keys(labels) : [];
      this._adhocCounters.set(name, new Counter({ name, help: name, labelNames }));
    }
    const counter = this._adhocCounters.get(name)!;
    labels ? counter.labels(labels).inc() : counter.inc();
  }

  private _adhocCounters?: Map<string, Counter<string>>;
}
