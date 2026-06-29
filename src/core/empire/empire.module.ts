import { Module, Global } from '@nestjs/common';
import { DatabaseModule }           from '../../common/database/database.module';

import { OpsModule }                from '../ops/ops.module';
import { EmpireBrainService }       from './empire-brain.service';
import { GlobalPerformanceService } from './performance.service';
import { ReinvestService }          from './reinvest.service';
import { LongtermStrategyService }  from './longterm-strategy.service';
import { EmpireLimitsService }      from './limits.service';
import { CapitalGrowthEngine }      from './capital-growth.service';

@Global()
@Module({
  imports: [DatabaseModule,
 OpsModule],
  providers: [
    EmpireBrainService,
    GlobalPerformanceService,
    ReinvestService,
    LongtermStrategyService,
    EmpireLimitsService,
    CapitalGrowthEngine,
  ],
  exports: [
    EmpireBrainService,
    GlobalPerformanceService,
    ReinvestService,
    LongtermStrategyService,
    EmpireLimitsService,
    CapitalGrowthEngine,
  ],
})
export class EmpireModule {}
