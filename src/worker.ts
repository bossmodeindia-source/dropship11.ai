/**
 * worker.ts — V64 Standalone Worker Process
 *
 * Run via: node dist/src/worker.js
 *
 * Boots only modules needed for background job processing:
 *   - DatabaseModule, RedisModule, CryptoModule (AES-256 for token decryption)
 *   - AuditModule, SupplierModule, OrdersModule
 *   - WorkersModule     — OrderProcessor + DlqProcessor (BullMQ consumers)
 *   - CampaignDispatchModule — CAMPAIGN_LAUNCH + ORGANIC_POSTING consumers
 *
 * Does NOT expose HTTP — Railway marks this as a private service.
 * Shares env vars from the API service (DATABASE_URL, REDIS_URL, etc.)
 *
 * FIXED: Added configValidationSchema so required vars are validated at startup.
 * FIXED: Added CryptoModule so EncryptionService is available to all workers.
 * FIXED: Graceful shutdown now awaits app.close() before exit.
 */

import 'reflect-metadata';
import { NestFactory }     from '@nestjs/core';
import { Module, Logger }  from '@nestjs/common';
import { ConfigModule }    from '@nestjs/config';
import { ScheduleModule }  from '@nestjs/schedule';

import { configValidationSchema } from './common/config/config.validation';
import { DatabaseModule }         from './common/database/database.module';
import { RedisModule }            from './common/redis/redis.module';
import { CryptoModule }           from './common/crypto/crypto.module';
import { AuditModule }            from './audit/audit.module';
import { SupplierModule }         from './supplier/supplier.module';
import { OrdersModule }           from './orders/orders.module';
import { WorkersModule }          from './workers/workers.module';
import { CampaignDispatchModule } from './campaign-dispatch/campaign-dispatch.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal:         true,
      envFilePath:      ['.env.local', '.env'],
      validationSchema: configValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    CryptoModule,      // provides EncryptionService (needed by supplier token decryption)
    AuditModule,
    SupplierModule,
    OrdersModule,
    WorkersModule,
    CampaignDispatchModule,
  ],
})
class WorkerAppModule {}

async function bootstrapWorker(): Promise<void> {
  const logger = new Logger('WorkerBootstrap');

  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  // Graceful shutdown — await close before exit so BullMQ drains in-flight jobs
  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Worker received ${signal} — draining in-flight jobs (max 30s)...`);
    const timeout = setTimeout(() => {
      logger.error('Worker drain timeout — forcing exit');
      process.exit(1);
    }, 30_000);
    try {
      await app.close();
      clearTimeout(timeout);
      logger.log('Worker shut down cleanly');
      process.exit(0);
    } catch (err) {
      logger.error('Worker shutdown error', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  logger.log(
    '\n╔══════════════════════════════════════════════════════╗' +
    '\n║  AI EMPIRE V63 — WORKER PROCESS ONLINE              ║' +
    '\n║  Consumers: OrderProcessor, DlqProcessor,           ║' +
    '\n║             CampaignLaunch, OrganicPosting          ║' +
    '\n╚══════════════════════════════════════════════════════╝',
  );
}

bootstrapWorker().catch((err) => {
  console.error('Fatal worker bootstrap error:', err);
  process.exit(1);
});
