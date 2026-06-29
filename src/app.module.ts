/**
 * AppModule — AI EMPIRE ENTERPRISE PRODUCTION
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE: 3-LAYER MAXIMUM DEPTH
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   Infrastructure  →  Domain  →  Orchestration
 *
 * SINGLE ORCHESTRATOR: UnifiedCommerceOrchestrator
 *   ALL workflows execute through:
 *     MasterCommerceOrchestrator → WorkflowRegistry → Queue → Worker
 *
 * SINGLE DATA LAYER: Drizzle ORM only
 *   No raw pg.Pool in production services.
 *   Infrastructure bootstrap is the ONLY permitted Pool usage.
 *
 * SINGLE IMPLEMENTATION PER FEATURE:
 *   No legacy v* modules. No shadow coordinators. No parallel execution paths.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WEBHOOK HANDLERS (ONE per provider, certified idempotent)
 * ══════════════════════════════════════════════════════════════════════════════
 *   Shopify     → ShopifyWebhookController          (HMAC + Redis replay)
 *   Razorpay    → RazorpayWebhookController         (raw body HMAC)
 *   Escrow      → RazorpayOrderWebhookController    (payment order events)
 *   Telegram    → TelegramStorageFacade             (upload lifecycle)
 *   Supplier    → SupplierFulfillmentModule         (tracking events)
 *   ReturnShield→ ShopifyReturnInterceptController  (refund intercept)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * GUARD STACK (registered once, applied globally in order)
 * ══════════════════════════════════════════════════════════════════════════════
 *   1. TenantGuard   — binds tenant context
 *   2. JwtAuthGuard  — validates JWT
 *   3. RolesGuard    — RBAC enforcement
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * MIDDLEWARE STACK
 * ══════════════════════════════════════════════════════════════════════════════
 *   1. RateLimitMiddleware
 *   2. MaintenanceMiddleware
 *   3. TenantMiddleware
 *   4. RequestIdMiddleware
 */

import {
  Module,
  NestModule,
  MiddlewareConsumer,
  RequestMethod,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TerminusModule }              from '@nestjs/terminus';
import { BullModule }                  from '@nestjs/bullmq';
import { ScheduleModule }              from '@nestjs/schedule';

// ── Guards (canonical barrel) ─────────────────────────────────────────────────
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { TenantGuard }              from './tenant/tenant.guard';

// ── Canonical Execution Authority (@Global) ───────────────────────────────────
import { OrchestratorModule }       from './orchestrator/orchestrator.module';

// ── Canonical Finance Engine (@Global) ────────────────────────────────────────
import { FinanceModule }            from './finance/finance.module';

// ── @Global Infrastructure ─────────────────────────────────────────────────────
import { DatabaseModule }           from './common/database/database.module';
import { RedisModule }              from './common/redis/redis.module';
import { CryptoModule }             from './common/crypto/crypto.module';
import { MetricsModule }            from './metrics/metrics.module';

// ── @Global Platform Systems ──────────────────────────────────────────────────
import { TenantModule }             from './tenant/tenant.module';
import { AlertingModule }           from './alerting/alerting.module';
import { AuditModule }              from './audit/audit.module';
import { SystemModeModule }         from './system-mode/system-mode.module';
import { ObservabilityModule }      from './observability/observability.module';
import { ObservabilityInterceptor } from './observability/observability.interceptor';
import { CostProtectionModule }     from './cost-protection/cost-protection.module';
import { PlanLimitsModule }         from './plan-limits/plan-limits.module';

// ── Universal Webhook Idempotency (@Global — must load before webhook handlers) ─
import { WebhookModule }            from './common/webhook/webhook.module';

// ── Transactional Outbox (must load before domain modules) ────────────────────
import { OutboxModule }             from './common/outbox/outbox.module';
import { ReconciliationModule }     from './common/reconciliation/reconciliation.module';

// ── Infrastructure Services ────────────────────────────────────────────────────
import { QueueModule }              from './queue/queue.module';
import { VaultModule }              from './vault/vault.module';
import { FailSafeModule }           from './failsafe/failsafe.module';
import { RecoveryModule }           from './recovery/recovery.module';
import { StorageModule }            from './storage/storage.module';
import { TelegramStorageModule }    from './telegram-storage/telegram-storage.module';
import { RealtimeModule }           from './realtime/realtime.module';
import { HealthModule }             from './health/health.module';
import { ConfigVaultModule }        from './config-vault/config-vault.module';
import { AiBotModule }              from './ai-bot/ai-bot.module';
import { AiOrchestratorModule }     from './ai-orchestrator/ai-orchestrator.module';
import { WorkersModule }            from './workers/workers.module';
import { SupplierModule }           from './supplier/supplier.module';
import { NotificationsModule }      from './notifications/notifications.module';
import { TenantMiddleware }         from './tenant/tenant.middleware';
import { MaintenanceMiddleware }    from './common/middleware/maintenance.middleware';
import { RequestIdMiddleware }      from './common/middleware/request-id.middleware';
import { RateLimitMiddleware }      from './common/middleware/rate-limit.middleware';

// ── Auth ───────────────────────────────────────────────────────────────────────
import { AuthModule }               from './auth/auth.module';

// ── Payment / Finance Stack ────────────────────────────────────────────────────
import { SubscriptionModule }       from './subscription/subscription.module';
import { FinanceTrackingModule }    from './finance-tracking/finance-tracking.module';
import { WithdrawalModule }         from './withdrawal/withdrawal.module';
import { SupplierPaymentModule }    from './supplier-payment/supplier-payment.module';
import { FinancialFailsafeModule }  from './financial-failsafe/financial-failsafe.service';

// ── Commerce Domain ────────────────────────────────────────────────────────────
import { ProductsModule }           from './products/products.module';
import { OrdersModule }             from './orders/orders.module';
import { CampaignsModule }          from './campaigns/campaigns.module';
import { MetaAdsModule }            from './meta-ads/meta-ads.module';
import { AdCreativesModule }        from './ad-creatives/ad-creatives.module';
import { AiMediaModule }            from './ai-media/ai-media.module';
import { AdminModule }              from './admin/admin.module';
import { ShopifyModule }            from './shopify/shopify.module';


// ── Multi-Channel (@Global) ───────────────────────────────────────────────────
import { ChannelsModule }           from './core/channels/channels.module';

// ── Core Financial AI (V53 — unique cashflow forecasting) ─────────────────────
// NOTE: FinanceModule provides UnifiedFinanceEngine (canonical finance authority).
//       CoreFinanceModuleV53 provides FinancialAiService (AI-powered cashflow + tax
//       unique logic not in UnifiedFinanceEngine — both coexist intentionally).
import { FinanceModule as CoreFinanceModuleV53 } from './core/finance/finance.module';

// ── Bot Dispatch Layer (job queue routing — NOT an orchestrator) ───────────────
import { BotDispatchModule }        from './bot-orchestrator/bot-orchestrator.module';

// ── Commerce Execution ─────────────────────────────────────────────────────────
import { CommerceModule }           from './commerce/commerce.module';

// ── Predictive + Core Intelligence ────────────────────────────────────────────
import { PredictiveModule }         from './core/predictive/predictive.module';

// ── Brand + Engagement ─────────────────────────────────────────────────────────
import { BrandModule }              from './brand/brand.module';
import { AovModule }                from './aov/aov.module';
import { RetentionModule }          from './retention/retention.module';
import { InfluencerModule }         from './influencer/influencer.module';
import { ContentModule }            from './content/content.module';
import { PricingModule }            from './pricing/pricing.module';
import { SafetyModule }             from './safety/safety.module';
import { DashboardModule }          from './dashboard/dashboard.module';
import { AdPipelineModule }         from './pipeline/pipeline.module';
import { PlatformAdsModule }        from './platform-ads/platform-ads.module';

// ── AI Governance Layer ────────────────────────────────────────────────────────
import { AiProviderRegistryModule }       from './ai-provider-registry/ai-provider-registry.module';
import { UserAiConnectionsModule }        from './user-ai-connections/user-ai-connections.module';
import { UserBusinessConnectionsModule }  from './user-business-connections/user-business-connections.module';
import { VideoPipelineModule }            from './video-pipeline/video-pipeline.module';
import { CreativeViralityModule }         from './creative-virality/creative-virality.module';
import { ProviderRequestModule }          from './provider-request/provider-request.module';
import { AiUsageAnalyticsModule }         from './ai-usage-analytics/ai-usage-analytics.module';
import { CampaignDispatchModule }         from './campaign-dispatch/campaign-dispatch.module';

// ── Centralized Payments + Escrow + Fulfillment ─────────────────────────────────
import { EscrowModule }                   from './escrow/escrow.module';
import { SupplierFulfillmentModule }      from './supplier-fulfillment/supplier-fulfillment.module';
import { AdminFulfillmentModule }         from './admin-fulfillment/admin-fulfillment.module';

// ── Commerce Analytics + Growth ──────────────────────────────────────────────────
import { CommerceAnalyticsModule }        from './commerce-analytics/commerce-analytics.module';
import { CustomerLifecycleModule }        from './customer-lifecycle/customer-lifecycle.module';
import { RevenueOptimizationModule }      from './revenue-optimization/revenue-optimization.module';
import { AutonomousModule }               from './autonomous/autonomous.module';
import { AutonomousGrowthModule }         from './autonomous-growth/autonomous-growth.module';

// ── Intelligence + Media ─────────────────────────────────────────────────────────
import { CommerceBrainModule }            from './commerce-brain/commerce-brain.module';
import { TrendIntelligenceModule }        from './trend-intelligence/trend-intelligence.module';
import { ViralMediaEngineModule }         from './viral-media-engine/viral-media-engine.module';
import { SupplierRoutingModule }          from './supplier-routing/supplier-routing.module';

// ── Return Shield + Wallet ─────────────────────────────────────────────────────
import { ReturnShieldModule }             from './return-shield/return-shield.module';
import { WalletModule }                   from './wallet/wallet.module';

// ── SEO Automation ────────────────────────────────────────────────────────────
import { SEOAutomationModule }            from './seo/seo.module';

import { configValidationSchema }         from './common/config/config.validation';
import { markSystemReady }                from './common/system-state';

@Module({
  imports: [
    // ── Core configuration ─────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal:          true,
      envFilePath:       ['.env.local', '.env'],
      validationSchema:  configValidationSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      expandVariables:   true,
    }),

    ScheduleModule.forRoot(),

    ThrottlerModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{
          ttl:   config.get<number>('THROTTLE_TTL',   60) * 1000,
          limit: config.get<number>('THROTTLE_LIMIT', 100),
        }],
      }),
    }),
    TerminusModule,

    // ── BullMQ global Redis config ─────────────────────────────────────────
    BullModule.forRootAsync({
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        if (url) return { connection: { url } } as any;
        return {
          connection: {
            host:     config.get<string>('REDIS_HOST', 'localhost'),
            port:     config.get<number>('REDIS_PORT', 6379),
            password: config.get<string>('REDIS_PASSWORD') || undefined,
          },
        } as any;
      },
    }),

    // ── @Global Infrastructure (all others depend on these) ────────────────
    DatabaseModule,
    RedisModule,
    CryptoModule,
    MetricsModule,

    // ── @Global Canonical Systems (load FIRST) ─────────────────────────────
    FinanceModule,           // UnifiedFinanceEngine — SOLE finance authority
    OrchestratorModule,      // UnifiedCommerceOrchestrator — SOLE execution authority

    // ── @Global Platform Systems ───────────────────────────────────────────
    TenantModule,            // FIRST — all modules use TenantContext
    AlertingModule,
    AuditModule,
    SystemModeModule,
    ObservabilityModule,
    CostProtectionModule,
    PlanLimitsModule,

    // ── Universal Webhook Idempotency (before any webhook handler module) ──
    WebhookModule,

    // ── Transactional Outbox (before any domain module that emits events) ──
    OutboxModule,

    // ── Infrastructure ─────────────────────────────────────────────────────
    QueueModule,
    VaultModule,
    FailSafeModule,
    RecoveryModule,
    ReconciliationModule,
    StorageModule,
    TelegramStorageModule,
    RealtimeModule,
    HealthModule,
    ConfigVaultModule,
    AiBotModule,
    AiOrchestratorModule,
    WorkersModule,
    SupplierModule,
    NotificationsModule,

    // ── Auth ───────────────────────────────────────────────────────────────
    AuthModule,

    // ── Payment / Finance Stack ────────────────────────────────────────────
    SubscriptionModule,
    FinanceTrackingModule,
    WithdrawalModule,
    SupplierPaymentModule,
    FinancialFailsafeModule,

    // ── Commerce Domain ────────────────────────────────────────────────────
    ProductsModule,
    OrdersModule,
    CampaignsModule,
    MetaAdsModule,
    AdCreativesModule,
    AiMediaModule,
    ShopifyModule,
    AdminModule,

    // ── Multi-Channel (@Global) ────────────────────────────────────────────
    ChannelsModule,

    // ── Core Financial AI (V53 unique: cashflow + tax engine) ─────────────
    CoreFinanceModuleV53,

    // ── Bot Dispatch Layer (job routing — NOT an orchestrator) ─────────────
    BotDispatchModule,

    // ── Commerce Execution ─────────────────────────────────────────────────
    CommerceModule,

    // ── Predictive Intelligence ────────────────────────────────────────────
    PredictiveModule,

    // ── Brand + Engagement ─────────────────────────────────────────────────
    BrandModule,
    AovModule,
    RetentionModule,
    InfluencerModule,
    ContentModule,
    PricingModule,
    SafetyModule,
    DashboardModule,
    AdPipelineModule,
    PlatformAdsModule,

    // ── AI Governance ──────────────────────────────────────────────────────
    AiProviderRegistryModule,
    UserAiConnectionsModule,
    UserBusinessConnectionsModule,
    CreativeViralityModule,
    VideoPipelineModule,
    SEOAutomationModule,
    ProviderRequestModule,
    AiUsageAnalyticsModule,
    CampaignDispatchModule,

    // ── Payments + Escrow + Fulfillment ────────────────────────────────────
    EscrowModule,
    SupplierFulfillmentModule,
    AdminFulfillmentModule,

    // ── Commerce Analytics + Growth ────────────────────────────────────────
    CommerceAnalyticsModule,
    CustomerLifecycleModule,
    RevenueOptimizationModule,
    AutonomousModule,       // Product intelligence, bandit engine, niche discovery
    AutonomousGrowthModule,

    // ── Intelligence + Media ───────────────────────────────────────────────
    CommerceBrainModule,
    TrendIntelligenceModule,
    ViralMediaEngineModule,
    SupplierRoutingModule,

    // ── Return Shield + Wallet ─────────────────────────────────────────────
    WalletModule,
    ReturnShieldModule,
  ],

  controllers: [],

  providers: [
    // ── Guard stack (ONE registration each — applied globally) ─────────────
    { provide: APP_GUARD, useClass: TenantGuard   },  // 1. bind tenant context
    { provide: APP_GUARD, useClass: JwtAuthGuard  },  // 2. validate JWT
    { provide: APP_GUARD, useClass: RolesGuard    },  // 3. RBAC enforcement
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // 4. route-specific @Throttle limits

    // ── Global HTTP metrics interceptor ────────────────────────────────────
    { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
  ],
})
export class AppModule implements NestModule, OnModuleInit {
  private readonly logger = new Logger(AppModule.name);
  private static _systemReady = false;

  static isSystemReady(): boolean { return AppModule._systemReady; }

  static assertSystemReady(context: string): void {
    if (!AppModule._systemReady) {
      throw new Error(
        `SYSTEM_NOT_READY: "${context}" called before system initialization completed.`,
      );
    }
  }

  async onModuleInit(): Promise<void> {
    AppModule._systemReady = true;
    markSystemReady();

    this.logger.log(
      '✅ AI EMPIRE — ENTERPRISE CERTIFIED PRODUCTION SYSTEM ONLINE\n' +
      '  Architecture : 3-layer (Infrastructure → Domain → Orchestration)\n' +
      '  Orchestrator : UnifiedCommerceOrchestrator (SOLE execution authority)\n' +
      '  Finance      : UnifiedFinanceEngine (SOLE finance authority)\n' +
      '  Data Layer   : Drizzle ORM only (zero raw pg in production services)\n' +
      '  Legacy Debt  : ZERO (all v* modules purged)\n' +
      '  Webhooks     : Single certified handler per provider\n' +
      '  Guards       : TenantGuard → JwtAuthGuard → RolesGuard\n' +
      '  Escrow       : Atomic transactions + transactional outbox\n' +
      '  Return Shield: Admin-gated — no automatic financial reversals\n' +
      '  Commerce     : Full 10-step pipeline (Purchase→Escrow→Supplier→Tracking→Profit)',
    );
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RateLimitMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });

    consumer
      .apply(MaintenanceMiddleware)
      .exclude(
        { path: 'health',        method: RequestMethod.GET  },
        { path: 'metrics',       method: RequestMethod.GET  },
        { path: 'api/v1/auth/*', method: RequestMethod.ALL  },
        { path: 'admin/*',       method: RequestMethod.ALL  },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });

    consumer
      .apply(TenantMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });

    consumer
      .apply(RequestIdMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
