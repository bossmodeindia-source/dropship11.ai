import { Module } from '@nestjs/common';
import { AiUsageAnalyticsService } from './ai-usage-analytics.service';
import { AiUsageAnalyticsController } from './ai-usage-analytics.controller';

@Module({
  providers: [AiUsageAnalyticsService],
  controllers: [AiUsageAnalyticsController],
  exports: [AiUsageAnalyticsService],
})
export class AiUsageAnalyticsModule {}
