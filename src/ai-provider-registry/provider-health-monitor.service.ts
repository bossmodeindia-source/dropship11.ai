/**
 * ProviderHealthMonitorService
 *
 * Health checks are loaded from ai_provider_catalog, not from source-code
 * provider lists. If an admin adds a future provider with a health endpoint,
 * the monitor picks it up automatically.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiProviderRegistryService, AiProviderCatalogEntry } from './ai-provider-registry.service';
import { AlertingService } from '../alerting/alerting.service';

@Injectable()
export class ProviderHealthMonitorService {
  private readonly logger = new Logger(ProviderHealthMonitorService.name);

  constructor(
    private readonly registry: AiProviderRegistryService,
    private readonly alerting: AlertingService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async runHealthChecks(): Promise<void> {
    const providers = await this.registry.listApprovedProviders();
    if (providers.length === 0) return;

    const results = await Promise.allSettled(
      providers.map(provider => this.checkProvider(provider)),
    );

    const degraded = results.filter(result =>
      result.status === 'fulfilled' && result.value.status !== 'healthy',
    ).length;

    if (degraded > 0) {
      this.logger.warn(`[ProviderHealth] ${degraded}/${providers.length} providers degraded`);
    }
  }

  private async checkProvider(
    provider: AiProviderCatalogEntry,
  ): Promise<{ status: 'healthy' | 'degraded' | 'down'; latencyMs: number | null }> {
    const url = provider.healthCheckUrl ??
      this.joinUrl(provider.apiBaseUrl ?? provider.baseUrl, provider.endpointPath ?? '/');

    if (!url) {
      await this.registry.recordHealthSnapshot(provider.id, 'healthy', null);
      return { status: 'healthy', latencyMs: null };
    }

    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      const latencyMs = Date.now() - start;
      const isUp = res.status >= 200 && res.status < 500 && res.status !== 503;
      const status = isUp ? (latencyMs > 5000 ? 'degraded' : 'healthy') : 'down';

      await this.registry.recordHealthSnapshot(provider.id, status, latencyMs, undefined);

      if (status === 'down') {
        this.logger.warn(`[ProviderHealth] ${provider.providerKey} is DOWN (${res.status})`);
        await this.alerting.alertApiOutage(
          provider.providerKey,
          `Health check failed: HTTP ${res.status}, ${latencyMs}ms`,
        ).catch(() => undefined);
      }

      return { status, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error = (err as Error).message;
      await this.registry.recordHealthSnapshot(provider.id, 'down', latencyMs, error);
      this.logger.error(`[ProviderHealth] ${provider.providerKey} check FAILED: ${error}`);
      await this.alerting.alertApiOutage(
        provider.providerKey,
        `Health check threw: ${error}`,
      ).catch(() => undefined);
      return { status: 'down', latencyMs };
    }
  }

  private joinUrl(base?: string | null, path?: string | null): string | null {
    if (!base) return null;
    if (!path) return base;
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }
}
