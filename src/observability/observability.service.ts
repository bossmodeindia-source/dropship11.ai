/**
 * ObservabilityService — V59 Structured Logging + Metrics + Tracing
 *
 * Implements:
 *   - Structured JSON logging via Pino (request_id, tenant_id, user_id, duration)
 *   - Prometheus metrics exposition (/metrics endpoint)
 *   - Request tracing (X-Request-ID propagation)
 *   - Queue depth metrics
 *   - Business metrics (revenue, ROAS, active bots, winning products)
 *   - Infrastructure metrics (DB latency, Redis health, CPU/memory)
 *
 * Prometheus metrics exposed:
 *   Infrastructure:
 *     aiempire_api_request_duration_ms       — HTTP request latency histogram
 *     aiempire_api_request_total             — total requests by route/method/status
 *     aiempire_queue_depth                   — jobs waiting per queue
 *     aiempire_queue_failed_total            — failed jobs per queue
 *     aiempire_redis_health                  — 0/1 Redis reachability
 *     aiempire_db_query_duration_ms          — DB query latency
 *     aiempire_active_workers                — live worker processes
 *   Business:
 *     aiempire_revenue_total_usd             — total revenue (labeled by tenant)
 *     aiempire_roas                          — return on ad spend gauge
 *     aiempire_active_bots                   — bots currently running
 *     aiempire_winning_products              — products in winner state
 *     aiempire_failed_campaigns_total        — failed campaign counter
 *     aiempire_spend_today_usd               — ad spend today
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class ObservabilityService implements OnModuleInit {
  private readonly logger = new Logger(ObservabilityService.name);
  readonly registry: Registry;

  // ── Infrastructure metrics ────────────────────────────────────────────────
  readonly httpRequestDuration:  Histogram<string>;
  readonly httpRequestTotal:     Counter<string>;
  readonly queueDepth:           Gauge<string>;
  readonly queueFailedTotal:     Counter<string>;
  readonly redisHealth:          Gauge<string>;
  readonly dbQueryDuration:      Histogram<string>;
  readonly activeWorkers:        Gauge<string>;

  // ── Business metrics ──────────────────────────────────────────────────────
  readonly revenueTotal:         Counter<string>;
  readonly roasGauge:            Gauge<string>;
  readonly activeBots:           Gauge<string>;
  readonly winningProducts:      Gauge<string>;
  readonly failedCampaigns:      Counter<string>;
  readonly adSpendToday:         Gauge<string>;
  readonly tenantCount:          Gauge<string>;

  constructor(private readonly config: ConfigService) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ app: 'aiempire', env: config.get('NODE_ENV', 'production') });

    // Collect default Node.js metrics (CPU, memory, event loop lag, GC)
    collectDefaultMetrics({ register: this.registry, prefix: 'aiempire_node_' });

    // ── HTTP metrics ────────────────────────────────────────────────────────
    this.httpRequestDuration = new Histogram({
      name: 'aiempire_api_request_duration_ms',
      help: 'HTTP request latency in milliseconds',
      labelNames: ['method', 'route', 'status_code', 'tenant_id'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.registry],
    });

    this.httpRequestTotal = new Counter({
      name: 'aiempire_api_request_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    // ── Queue metrics ────────────────────────────────────────────────────────
    this.queueDepth = new Gauge({
      name: 'aiempire_queue_depth',
      help: 'Number of jobs waiting in queue',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
    });

    this.queueFailedTotal = new Counter({
      name: 'aiempire_queue_failed_total',
      help: 'Total failed jobs per queue',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    // ── Infrastructure health ────────────────────────────────────────────────
    this.redisHealth = new Gauge({
      name: 'aiempire_redis_health',
      help: '1 = Redis healthy, 0 = unreachable',
      registers: [this.registry],
    });

    this.dbQueryDuration = new Histogram({
      name: 'aiempire_db_query_duration_ms',
      help: 'PostgreSQL query latency in milliseconds',
      labelNames: ['query_type'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [this.registry],
    });

    this.activeWorkers = new Gauge({
      name: 'aiempire_active_workers',
      help: 'Number of active worker processes',
      registers: [this.registry],
    });

    // ── Business metrics ─────────────────────────────────────────────────────
    this.revenueTotal = new Counter({
      name: 'aiempire_revenue_total_usd',
      help: 'Total revenue in USD',
      labelNames: ['tenant_id', 'source'],
      registers: [this.registry],
    });

    this.roasGauge = new Gauge({
      name: 'aiempire_roas',
      help: 'Return on ad spend (revenue / ad_spend)',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.activeBots = new Gauge({
      name: 'aiempire_active_bots',
      help: 'Number of currently running bots',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.winningProducts = new Gauge({
      name: 'aiempire_winning_products',
      help: 'Number of products in winner state',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.failedCampaigns = new Counter({
      name: 'aiempire_failed_campaigns_total',
      help: 'Total failed campaigns',
      labelNames: ['tenant_id', 'reason'],
      registers: [this.registry],
    });

    this.adSpendToday = new Gauge({
      name: 'aiempire_spend_today_usd',
      help: 'Ad spend today in USD',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.tenantCount = new Gauge({
      name: 'aiempire_tenant_count',
      help: 'Total active tenants',
      labelNames: ['plan'],
      registers: [this.registry],
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('✅ ObservabilityService: Prometheus metrics initialized');
  }

  // ── Metric helpers ────────────────────────────────────────────────────────

  recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number, tenantId?: string): void {
    this.httpRequestDuration.observe({ method, route, status_code: String(statusCode), tenant_id: tenantId ?? '' }, durationMs);
    this.httpRequestTotal.inc({ method, route, status_code: String(statusCode) });
  }

  recordQueueDepth(queue: string, waiting: number, active: number, failed: number): void {
    this.queueDepth.set({ queue, state: 'waiting' }, waiting);
    this.queueDepth.set({ queue, state: 'active' }, active);
    this.queueDepth.set({ queue, state: 'failed' }, failed);
  }

  recordQueueFailure(queue: string): void {
    this.queueFailedTotal.inc({ queue });
  }

  setRedisHealth(healthy: boolean): void {
    this.redisHealth.set(healthy ? 1 : 0);
  }

  recordDbQuery(queryType: string, durationMs: number): void {
    this.dbQueryDuration.observe({ query_type: queryType }, durationMs);
  }

  recordRevenue(tenantId: string, amountUsd: number, source: string): void {
    this.revenueTotal.inc({ tenant_id: tenantId, source }, amountUsd);
  }

  setRoas(tenantId: string, roas: number): void {
    this.roasGauge.set({ tenant_id: tenantId }, roas);
  }

  setActiveBots(tenantId: string, count: number): void {
    this.activeBots.set({ tenant_id: tenantId }, count);
  }

  setWinningProducts(tenantId: string, count: number): void {
    this.winningProducts.set({ tenant_id: tenantId }, count);
  }

  recordFailedCampaign(tenantId: string, reason: string): void {
    this.failedCampaigns.inc({ tenant_id: tenantId, reason });
  }

  setAdSpendToday(tenantId: string, spendUsd: number): void {
    this.adSpendToday.set({ tenant_id: tenantId }, spendUsd);
  }

  setTenantCount(plan: string, count: number): void {
    this.tenantCount.set({ plan }, count);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
