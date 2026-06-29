import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../common/database/database.module';
import { AovModule } from '../aov/aov.module';
import { RetentionModule } from '../retention/retention.module';
import { InfluencerModule } from '../influencer/influencer.module';
import { ContentModule } from '../content/content.module';
import { PricingModule } from '../pricing/pricing.module';
import { SafetyModule } from '../safety/safety.module';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [
    DatabaseModule,
    ScheduleModule.forRoot(),
    AovModule,
    RetentionModule,
    InfluencerModule,
    ContentModule,
    PricingModule,
    SafetyModule,
  ],
  providers: [DashboardService],
  controllers: [DashboardController],
  exports: [DashboardService],
})
export class DashboardModule {}
