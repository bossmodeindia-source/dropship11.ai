// commerce-analytics.module.ts
import { Module } from '@nestjs/common';
import { CommerceAnalyticsService } from './commerce-analytics.service';
import { CommerceAnalyticsController } from './commerce-analytics.controller';

@Module({
  providers:   [CommerceAnalyticsService],
  controllers: [CommerceAnalyticsController],
  exports:     [CommerceAnalyticsService],
})
export class CommerceAnalyticsModule {}
