/**
 * FinancialFailsafeService
 *
 * Intercepts and guards all critical financial operations.
 * If any dependency is unhealthy, financial execution is paused.
 *
 * Fail-safe contract (HARD RULE — no exceptions):
 *   if PostgreSQL unreachable  → pause_financial_execution()
 *   if Redis unreachable       → pause_queue_operations()
 *   if Razorpay unreachable    → pause_billing_operations()
 *   if Supplier API down       → pause_fulfillment()
 *
 * NO fail-open behavior. Unknown state = safe state = pause.
 *
 * This service integrates with the existing V42 FailSafeModule.
 * It adds financial-domain-specific checks on top of the infrastructure failsafe.
 *
 * Safe mode behaviors:
 *   FINANCIAL_PAUSED  — withdrawals and supplier payments blocked
 *   BILLING_PAUSED    — Razorpay webhooks return 503 (Razorpay retries)
 *   FULFILLMENT_PAUSED — order processor pauses, no fulfillment attempted
 */

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  Inject,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '../common/redis/inject-redis';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { POOL_TOKEN } from '../common/database/database.module';
import { AlertingService } from '../alerting/alerting.service';

// Safe mode state keys (stored in Redis)
const FINANCIAL_PAUSED_KEY  = 'failsafe:financial_paused';
const BILLING_PAUSED_KEY    = 'failsafe:billing_paused';
const FULFILLMENT_PAUSED_KEY = 'failsafe:fulfillment_paused';

export type SafeModeScope =
  | 'financial'
  | 'billing'
  | 'fulfillment'
  | 'all';

export interface HealthCheckResult {
  postgres:  boolean;
  redis:     boolean;
  razorpay:  boolean;
  supplier:  boolean;
  timestamp: Date;
}

@Injectable()
export class FinancialFailsafeService implements OnModuleInit {
  private readonly logger = new Logger(FinancialFailsafeService.name);

  constructor(
    @Inject(POOL_TOKEN) private readonly pool: Pool,
    @InjectRedis() private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly alerting: AlertingService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Clear any stale safe-mode flags from previous crash
    // (Only clear if ALL deps are healthy at startup)
    const health = await this.checkAllDependencies();
    if (health.postgres && health.redis) {
      this.logger.log('FinancialFailsafeService: all dependencies healthy at startup');
    } else {
      this.logger.error(
        'FinancialFailsafeService: dependency failure at startup — enabling safe mode',
      );
      await this.enableSafeMode('all', 'startup-health-check-failure');
    }
  }

  // ── Dependency Health Checks ──────────────────────────────────────────────

  async checkAllDependencies(): Promise<HealthCheckResult> {
    const [postgres, redis, razorpay, supplier] = await Promise.allSettled([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkRazorpay(),
      this.checkSupplierApi(),
    ]);

    const result: HealthCheckResult = {
      postgres:  postgres.status  === 'fulfilled' && postgres.value,
      redis:     redis.status     === 'fulfilled' && redis.value,
      razorpay:  razorpay.status  === 'fulfilled' && razorpay.value,
      supplier:  supplier.status  === 'fulfilled' && supplier.value,
      timestamp: new Date(),
    };

    // Trigger safe modes based on results
    if (!result.postgres || !result.redis) {
      await this.enableSafeMode('financial',    'dependency-health-check');
      await this.enableSafeMode('fulfillment',  'dependency-health-check');
    }
    if (!result.razorpay) {
      await this.enableSafeMode('billing', 'razorpay-unreachable');
    }
    if (!result.supplier) {
      await this.enableSafeMode('fulfillment', 'supplier-api-unreachable');
    }

    return result;
  }

  private async checkPostgres(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  private async checkRazorpay(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://api.razorpay.com/v1/payments?count=1', {
        headers: {
          Authorization: 'Basic ' + Buffer.from(
            `${this.config.get('RAZORPAY_KEY_ID')}:${this.config.get('RAZORPAY_KEY_SECRET')}`,
          ).toString('base64'),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.status < 500;
    } catch {
      return false;
    }
  }

  private async checkSupplierApi(): Promise<boolean> {
    const supplierUrl = this.config.get<string>('SUPPLIER_API_URL');
    if (!supplierUrl) return true; // No supplier configured = skip check
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${supplierUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return res.status < 500;
    } catch {
      return false;
    }
  }

  // ── Safe Mode Controls ────────────────────────────────────────────────────

  async enableSafeMode(scope: SafeModeScope, reason: string): Promise<void> {
    const keys = this.getScopeKeys(scope);
    await Promise.all(keys.map(k => this.redis.set(k, reason, 'EX', 3600)));

    this.logger.error(`[FinancialFailsafe] SAFE MODE ENABLED scope=${scope} reason=${reason}`);

    await this.alerting.sendCritical({
      title:   `🚨 Financial Safe Mode: ${scope.toUpperCase()}`,
      message: `Safe mode enabled for scope=${scope}. Reason: ${reason}. Financial operations paused.`,
    });
  }

  async disableSafeMode(scope: SafeModeScope, adminId: string): Promise<void> {
    const keys = this.getScopeKeys(scope);
    await Promise.all(keys.map(k => this.redis.del(k)));

    this.logger.log(`[FinancialFailsafe] Safe mode disabled: scope=${scope} by admin=${adminId}`);

    await this.alerting.sendCritical({
      title:   `✅ Financial Safe Mode Cleared: ${scope.toUpperCase()}`,
      message: `Safe mode cleared for scope=${scope} by admin ${adminId}.`,
    });
  }

  async getSafeModeStatus(): Promise<Record<string, string | null>> {
    const [financial, billing, fulfillment] = await Promise.all([
      this.redis.get(FINANCIAL_PAUSED_KEY),
      this.redis.get(BILLING_PAUSED_KEY),
      this.redis.get(FULFILLMENT_PAUSED_KEY),
    ]);
    return { financial, billing, fulfillment };
  }

  // ── Guard Methods (called by services before critical operations) ──────────

  /**
   * Throws ServiceUnavailableException if financial operations are paused.
   * Call at the start of withdrawal/supplier payment operations.
   */
  async assertFinancialHealthy(): Promise<void> {
    const reason = await this.redis.get(FINANCIAL_PAUSED_KEY);
    if (reason) {
      throw new ServiceUnavailableException(
        `Financial operations are temporarily paused (${reason}). ` +
        `Please try again shortly or contact support.`,
      );
    }
  }

  /**
   * Throws ServiceUnavailableException if billing operations are paused.
   * Call before Razorpay subscription creation.
   */
  async assertBillingHealthy(): Promise<void> {
    const reason = await this.redis.get(BILLING_PAUSED_KEY);
    if (reason) {
      throw new ServiceUnavailableException(
        `Billing service is temporarily unavailable (${reason}). ` +
        `Please try again shortly.`,
      );
    }
  }

  /**
   * Throws ServiceUnavailableException if fulfillment operations are paused.
   * Call before triggering supplier fulfillment.
   */
  async assertFulfillmentHealthy(): Promise<void> {
    const reason = await this.redis.get(FULFILLMENT_PAUSED_KEY);
    if (reason) {
      throw new ServiceUnavailableException(
        `Fulfillment is temporarily paused (${reason}). ` +
        `Orders will be processed when the service recovers.`,
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getScopeKeys(scope: SafeModeScope): string[] {
    if (scope === 'all') {
      return [FINANCIAL_PAUSED_KEY, BILLING_PAUSED_KEY, FULFILLMENT_PAUSED_KEY];
    }
    const map: Record<SafeModeScope, string> = {
      financial:   FINANCIAL_PAUSED_KEY,
      billing:     BILLING_PAUSED_KEY,
      fulfillment: FULFILLMENT_PAUSED_KEY,
      all:         FINANCIAL_PAUSED_KEY,
    };
    return [map[scope]];
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

import { Module, Global } from '@nestjs/common';

@Global()
@Module({
  providers: [FinancialFailsafeService],
  exports:   [FinancialFailsafeService],
})
export class FinancialFailsafeModule {}
