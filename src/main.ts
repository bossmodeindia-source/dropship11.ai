/**
 * main.ts — V65 PRODUCTION
 *
 * V65 changes vs V64:
 *   OTEL  OpenTelemetry distributed tracing (import MUST be first — instruments at require())
 *   SEC   AdminModule: removed v59+v60 controllers (non-deterministic routing fix)
 *   SEC   OrganicModule: removed duplicate scheduler (double-posting fix)
 *   FIN   EscrowModule: idempotent creation + transactional status + outbox
 *   INF   OutboxModule + ReconciliationModule registered in AppModule
 *   OBS   QueueDepthAlerterService added to ObservabilityModule
 *   AI    AiProviderResilienceService: fallback chains + degraded mode
 *   DB    Migration 013: unique constraint + outbox table + 17 indexes
 *
 * V64 changes retained:
 *   ReturnShieldModule, WalletModule (admin-governed returns + wallet system)
 *
 * Boot sequence (ORDER IS CRITICAL):
 *   1.  OTEL tracing bootstrap (before any require())
 *   2.  NestExpressApplication (bufferLogs)
 *   3.  Trust proxy
 *   4.  RAW BODY CAPTURE  ← MUST come before any body-parser middleware
 *   5.  Compression + Helmet + CORS
 *   6.  Request-ID injection
 *   7.  Body parsers (json + urlencoded)
 *   8.  Global Pipes / Filters / Interceptors
 *   9.  API versioning + global prefix
 *   10. Swagger (non-prod or SWAGGER_ENABLED=true)
 *   11. Shutdown hooks
 *   12. listen() with keepalive tuning
 */

import './observability/tracing';       // ← V65: MUST be first — instruments at require() time
import 'reflect-metadata';
import * as express                     from 'express';
import { NestFactory, Reflector }       from '@nestjs/core';
import { NestExpressApplication }       from '@nestjs/platform-express';
import { ValidationPipe, Logger }       from '@nestjs/common';
import { ConfigService }                from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet                           from 'helmet';
import * as compression                 from 'compression';
import { v4 as uuidv4 }                from 'uuid';

import { AppModule }                 from './app.module';
import { HttpExceptionFilter }       from './common/filters/http-exception.filter';
import { AllExceptionsFilter }       from './common/filters/all-exceptions.filter';
import { LoggingInterceptor }        from './common/interceptors/logging.interceptor';
import { TransformInterceptor }      from './common/interceptors/transform.interceptor';
import { TimeoutInterceptor }        from './common/interceptors/timeout.interceptor';
import { MetricsInterceptor }        from './metrics/metrics.interceptor';
import { MetricsService }            from './metrics/metrics.service';
import { ObservabilityInterceptor } from './observability/observability.interceptor';
import { ObservabilityService }      from './observability/observability.service';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:     ['error', 'warn', 'log', 'debug'],
    bufferLogs: true,
  });

  const config  = app.get(ConfigService);
  const port    = config.get<number>('PORT', 3000);
  const env     = config.get<string>('NODE_ENV', 'development');
  const isProd  = env === 'production';

  // ── 1. Trust proxy (Nginx / K8s ingress / Cloudflare) ────────────────────
  app.set('trust proxy', 1);

  // ── 2. RAW BODY CAPTURE — V60 P0-2 FIX ──────────────────────────────────
  // MUST come before express.json(). Captures raw body into req.rawBody Buffer.
  // Required for: Razorpay HMAC (sha256 of raw body)
  //               Shopify webhook HMAC (sha256 of raw body)
  app.use(
    (req: express.Request & { rawBody?: Buffer }, _res: express.Response, next: express.NextFunction) => {
      let data = Buffer.alloc(0);
      req.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => {
        req.rawBody = data;
        req._body = false; // reset so body-parsers can still parse
        next();
      });
      req.on('error', next);
    },
  );

  // ── 3. Compression ────────────────────────────────────────────────────────
  app.use(compression());

  // ── 4. Helmet (granular HTTP security headers) ────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? {
        directives: {
          defaultSrc: ["'self'"],
          // FIX (v64): Added https://telegram.org — required for Telegram Login Widget.
          // Previous value ["'self'"] silently blocked the widget script from loading.
          scriptSrc:  ["'self'", 'https://telegram.org'],
          styleSrc:   ["'self'", "'unsafe-inline'"],
          imgSrc:     ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          frameSrc:   ["'none'"],
          objectSrc:  ["'none'"],
        },
      } : false,
      crossOriginEmbedderPolicy: false,
      hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // ── 5. CORS ───────────────────────────────────────────────────────────────
  const allowedOrigins = (config.get<string>('ALLOWED_ORIGINS', '') || '')
    .split(',').map((o) => o.trim()).filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || !isProd) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Request-ID'],
  });

  // ── 6. Request ID injection ───────────────────────────────────────────────
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string) || uuidv4();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
  });

  // ── 7. Body parsers (AFTER raw body capture) ──────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── 8. Global validation pipe ─────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:            true,
      forbidNonWhitelisted: true,
      transform:            true,
      transformOptions:     { enableImplicitConversion: true },
    }),
  );

  // ── 9. Global filters (LIFO) ──────────────────────────────────────────────
  const reflector = app.get(Reflector);
  app.useGlobalFilters(
    new AllExceptionsFilter(),
    new HttpExceptionFilter(),
  );

  // ── 10. Global interceptors ────────────────────────────────────────────────
  const metricsService = app.get(MetricsService);
  const obsService = app.get(ObservabilityService);
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new MetricsInterceptor(metricsService),
    new ObservabilityInterceptor(obsService),
    new TimeoutInterceptor(),
    new TransformInterceptor(),
  );

  // ── 11. API versioning + global prefix ────────────────────────────────────
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });

  // ── 12. Swagger (non-prod or SWAGGER_ENABLED=true) ────────────────────────
  const swaggerEnabled = config.get<string>('SWAGGER_ENABLED') === 'true';
  if (!isProd || swaggerEnabled) {
    const docBuilder = new DocumentBuilder()
      .setTitle('AI Empire API — V64 ReturnShield + Wallet + CommerceBrain')
      .setDescription(
        'AI Empire autonomous commerce platform — V63.\n\n' +
        '**V63 features:** CommerceBrain (13 AI sub-brains), TrendIntelligence (Google/TikTok/Meta), ' +
        'ViralMediaEngine (Telegram CDN), Telegram Login Widget auth, ' +
        'Thompson Sampling creative bandit, autonomous growth loops.\n\n' +
        '**Auth:** POST /auth/register, POST /auth/login, POST /auth/telegram (Telegram Login Widget), ' +
        'GET /auth/telegram/callback (redirect mode). All protected routes require Bearer token.\n\n' +
        'Creative Virality Engine (Thompson Sampling + CTR/ROAS prediction).\n\n' +
        '**V60 retained:** Unified orchestrator (sole execution authority), ' +
        'unified finance engine (sole finance authority), hardened webhooks (HMAC + replay protection), ' +
        'distributed locks (Lua CAS + TTL + heartbeat), disaster recovery (5-min scheduled).',
      )
      .setVersion('64.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Tenant-ID' }, 'tenant-id')
      .build();

    const document = SwaggerModule.createDocument(app, docBuilder);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
    });
    logger.log('📚 Swagger docs: http://localhost:' + port + '/api/docs');
  }

  // ── 13. Graceful shutdown ─────────────────────────────────────────────────
  app.enableShutdownHooks();

  const DRAIN_MS = 30_000;
  const forceExit = (signal: string) => {
    logger.warn(`${signal} received — beginning 30s graceful drain...`);
    setTimeout(() => { logger.error('Drain timeout — forcing exit'); process.exit(1); }, DRAIN_MS).unref();
  };
  process.on('SIGTERM', () => forceExit('SIGTERM'));
  process.on('SIGINT',  () => forceExit('SIGINT'));

  // ── 14. Listen ────────────────────────────────────────────────────────────
  const server = await app.listen(port, '0.0.0.0');
  server.keepAliveTimeout = 65_000; // > AWS ALB 60s idle timeout
  server.headersTimeout   = 66_000; // must be > keepAliveTimeout

  logger.log(
    '\n╔══════════════════════════════════════════════════════════════════╗' +
    '\n║     AI EMPIRE V64 — RETURN SHIELD + WALLET ONLINE                      ║' +
    '\n╠══════════════════════════════════════════════════════════════════╣' +
    `\n║  Port          : ${String(port).padEnd(46)}║` +
    `\n║  Environment   : ${String(env).padEnd(46)}║` +
    '\n║  Raw body      : ✅ Enabled (Razorpay + Shopify HMAC)            ║' +
    '\n║  Guard stack   : TenantGuard → JwtAuthGuard → RolesGuard        ║' +
    '\n║  AI Governance : AiProviderRegistryModule (admin-governed)       ║' +
    '\n║  User AI Layer : UserAiConnectionsModule (AES-256-GCM isolated)  ║' +
    '\n║  Video Pipeline: script→image→video→FFmpeg→TelegramCDN          ║' +
    '\n║  Orchestrator  : UnifiedCommerceOrchestrator (sole authority)   ║' +
    '\n║  Finance       : UnifiedFinanceEngine (sole authority)          ║' +
    '\n║  Queues        : 10 canonical BullMQ queues + 10 DLQs           ║' +
    '\n║  Recovery      : DisasterRecoveryService (5-min scheduled)      ║' +
    '\n║  Locks         : Lua CAS + TTL + heartbeat + stale cleanup      ║' +
    '\n║  Secrets       : K8s Secret refs (no ConfigMap plaintext)       ║' +
    '\n╚══════════════════════════════════════════════════════════════════╝',
  );
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
