import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '../common/database/database.module';
import { SmartPricingEngine } from './smart-pricing.engine';
import { PricingController } from './pricing.controller';

@Module({
  imports: [DatabaseModule, ScheduleModule.forRoot()],
  providers: [SmartPricingEngine],
  controllers: [PricingController],
  exports: [SmartPricingEngine],
})
export class PricingModule {}
