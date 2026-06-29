import { Module } from '@nestjs/common';
import { ProfitService } from './profit.service';

@Module({
  providers: [ProfitService],
  exports:   [ProfitService],
})
export class FinancialModule {}
