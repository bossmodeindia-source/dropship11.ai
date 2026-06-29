/**
 * SupplyModule — V51
 *
 * Provides: SupplierIntelligence, SupplierSelector, DeliveryPredictor,
 *           OrderGenerator, OrderController.
 *
 * Requires: DatabaseModule (Pool),
 (AdminTokenGuard).
 */

import { Module }                       from '@nestjs/common';
import { DatabaseModule }               from '../../common/database/database.module';

import { SupplierIntelligenceService }  from './supplier-intelligence.service';
import { SupplierSelectorService }      from './supplier-selector.service';
import { DeliveryPredictorService }     from './delivery-predictor.service';
import { OrderGeneratorService }        from './order-generator.service';
import { OrderController }             from './order.controller';
import { POOL_TOKEN }                   from '../../common/database/database.module';
import { Pool }                         from 'pg';

@Module({
  imports: [
    DatabaseModule,
  // AdminTokenGuard
  ],
  providers: [
    {
      provide:    SupplierIntelligenceService,
      useFactory: (pool: Pool) => new SupplierIntelligenceService(pool),
      inject:     [POOL_TOKEN],
    },
    SupplierSelectorService,
    DeliveryPredictorService,
    {
      provide:    OrderGeneratorService,
      useFactory: (pool: Pool, delivery: DeliveryPredictorService) =>
        new OrderGeneratorService(pool, delivery),
      inject: [POOL_TOKEN, DeliveryPredictorService],
    },
  ],
  controllers: [OrderController],
  exports: [
    SupplierIntelligenceService,
    SupplierSelectorService,
    DeliveryPredictorService,
    OrderGeneratorService,
  ],
})
export class SupplyModule {}
