import { Module }                   from '@nestjs/common';
import { SupplierRoutingEngine }     from './supplier-routing-engine.service';
import { SupplierRoutingController } from './supplier-routing.controller';
import { CommerceBrainModule }       from '../commerce-brain/commerce-brain.module';
import { DatabaseModule }            from '../common/database/database.module';
import { MetricsModule }             from '../metrics/metrics.module';

@Module({
  imports:     [DatabaseModule, CommerceBrainModule, MetricsModule],
  providers:   [SupplierRoutingEngine],
  controllers: [SupplierRoutingController],
  exports:     [SupplierRoutingEngine],
})
export class SupplierRoutingModule {}
