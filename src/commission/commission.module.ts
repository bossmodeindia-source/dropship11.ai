import { Module, Global } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { CommissionController } from './commission.controller';

@Global()
@Module({
  controllers: [CommissionController],
  providers:   [CommissionService],
  exports:     [CommissionService],
})
export class CommissionModule {}
