/**
 * AdPipelineModule — V67 Enterprise Certified
 *
 * V67 CRITICAL FIX #2: TypeORM REMOVED — Drizzle ONLY
 *
 *   ❌ REMOVED: TypeOrmModule.forFeature([Creative, CreativePerformance, LearningData, BanditSession, PipelineRun])
 *   ❌ REMOVED: @nestjs/typeorm, typeorm
 *   ✅ ADDED:   DatabaseModule (Drizzle) injection for all pipeline services
 *
 * All pipeline services now use @Inject(DB_TOKEN) and Drizzle queries
 * against the canonical schema.ts table definitions.
 *
 * Table definitions: src/common/database/schema.ts
 *   creatives, creativePerformance, learningData, banditSessions, pipelineRuns
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';

import { CreativeScoringService }   from './modules/creative-scoring/creative-scoring.service';
import { ThompsonSamplingService }  from './modules/bandit/thompson-sampling.service';
import { AdPipelineService }        from './modules/pipeline/ad-pipeline.service';
import {
  V49PredictionLayer,
  V54ReasoningLayer,
  V53FinanceLayer,
  V29StrategyLayer,
  V46ProductDiscoveryLayer,
} from './modules/v-layers/v-layers.service';
import { PipelineController }       from './pipeline.controller';

@Module({
  imports: [
    DatabaseModule,  // V67: provides DB_TOKEN (Drizzle) to all pipeline services
    // TypeOrmModule.forFeature([...]) — REMOVED in V67
  ],
  providers: [
    CreativeScoringService,
    ThompsonSamplingService,
    AdPipelineService,
    V49PredictionLayer,
    V54ReasoningLayer,
    V53FinanceLayer,
    V29StrategyLayer,
    V46ProductDiscoveryLayer,
  ],
  controllers: [PipelineController],
  exports: [
    AdPipelineService,
    CreativeScoringService,
    ThompsonSamplingService,
    V53FinanceLayer,
  ],
})
export class AdPipelineModule {}
