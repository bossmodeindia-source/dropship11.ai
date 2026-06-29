import { Module, Global } from '@nestjs/common';
import { FinancialAiService } from './financial-ai.service';
import { CashflowService }    from './cashflow.service';
import { TaxService }         from './tax.service';
import { FinanceController }  from './finance.controller';

@Global()
@Module({
  controllers: [FinanceController],
  providers:   [FinancialAiService, CashflowService, TaxService],
  exports:     [FinancialAiService, CashflowService, TaxService],
})
export class FinanceModule {}
