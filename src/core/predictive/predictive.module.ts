/**
 * PredictiveModule — V49
 *
 * @Global() — all modules receive PredictiveEngine via DI
 * without needing to import this module explicitly.
 *
 * Import AFTER
 (AlertingService dependency).
 * Import BEFORE V26Module, WinnerDetectionModule, V29Module.
 *
 * Pool is injected from the global DatabaseModule via POOL_TOKEN ('PG_POOL').
 * AlertingService is injected from
 (must be loaded first in AppModule).
 */

import { Module, Global } from '@nestjs/common';
import { Pool }              from 'pg';
import { POOL_TOKEN }        from '../../common/database/database.module';
import { FeatureBuilderService } from './feature-builder.service';
import { ModelService }          from './model.service';
import { PredictiveEngine }      from './predictive.engine';
import { PredictiveController }  from './predictive.controller';
import { AlertingService }          from '../../alerting/alerting.service';

@Global()
@Module({
  providers: [
    {
      provide:    FeatureBuilderService,
      useFactory: (pool: Pool) => new FeatureBuilderService(pool),
      inject:     [POOL_TOKEN],
    },
    ModelService,
    {
      provide:    PredictiveEngine,
      useFactory: (
        pool:            Pool,
        featureBuilder:  FeatureBuilderService,
        model:           ModelService,
        alert:           AlertingService,
      ) => new PredictiveEngine(pool, featureBuilder, model, alert),
      inject: [POOL_TOKEN, FeatureBuilderService, ModelService, AlertingService],
    },
  ],
  controllers: [PredictiveController],
  exports: [
    PredictiveEngine,
    ModelService,
  ],
})
export class PredictiveModule {}
