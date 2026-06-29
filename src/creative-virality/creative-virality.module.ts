import { Module }                   from '@nestjs/common';
import { CreativeScoringService }   from './creative-scoring.service';
import { ViralityPredictionService }from './virality-prediction.service';
import { ThompsonSamplingService }  from './thompson-sampling.service';
import { DatabaseModule }           from '../common/database/database.module';

@Module({
  imports:   [DatabaseModule],
  providers: [CreativeScoringService, ViralityPredictionService, ThompsonSamplingService],
  exports:   [CreativeScoringService, ViralityPredictionService, ThompsonSamplingService],
})
export class CreativeViralityModule {}
