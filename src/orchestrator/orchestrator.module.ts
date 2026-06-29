/**
 * OrchestratorModule — V66 Enterprise Certified
 *
 * V66 FIX: BullModule from @nestjs/bullmq (BullMQ v5 only)
 * V66 FIX: Distributed lock key = autonomous:cycle:lock
 * V66 FIX: Single orchestrator enforced via Redis distributed lock
 *
 * @Global — UnifiedCommerceOrchestrator available everywhere without re-importing.
 *
 * FORBIDDEN: Multiple orchestrators | parallel autonomous loops | @nestjs/bull
 */

import { Global, Module }  from '@nestjs/common';
import { BullModule }      from '@nestjs/bullmq';   // V66: BullMQ only

import { UnifiedCommerceOrchestrator } from './unified-commerce-orchestrator.service';
import { CanonicalQueue }              from '../queue/canonical-queues';
import { RedisModule }                 from '../common/redis/redis.module';
import { FinanceModule }               from '../finance/finance.module';

@Global()
@Module({
  imports: [
    RedisModule,
    FinanceModule,
    // V66: All queues registered via BullMQ (@nestjs/bullmq)
    BullModule.registerQueue(
      { name: CanonicalQueue.PRODUCT_DISCOVERY },
      { name: CanonicalQueue.CREATIVE_GENERATION },
      { name: CanonicalQueue.CAMPAIGN_LAUNCH },
      { name: CanonicalQueue.SUPPLIER_FULFILLMENT },
      { name: CanonicalQueue.LEARNING_LOOP },
    ),
  ],
  providers: [UnifiedCommerceOrchestrator],
  exports:   [UnifiedCommerceOrchestrator],
})
export class OrchestratorModule {}
