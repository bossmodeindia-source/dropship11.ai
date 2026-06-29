/**
 * FinanceController — V53 Dashboard APIs
 *
 * GET /finance/summary   — global profit breakdown
 * GET /finance/cashflow  — cashflow state (30d)
 * GET /finance/profit    — profit + tax estimate
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard }     from '../../common/guards/jwt-auth.guard';
import { FinancialAiService } from './financial-ai.service';
import { CashflowService }    from './cashflow.service';
import { TaxService }         from './tax.service';

@UseGuards(JwtAuthGuard)
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly financialAi: FinancialAiService,
    private readonly cashflow:    CashflowService,
    private readonly tax:         TaxService,
  ) {}

  @Get('summary')
  async getSummary() {
    return this.financialAi.getGlobalSummary();
  }

  @Get('cashflow')
  async getCashflow(@Query('days') days = '30') {
    return this.cashflow.getState(parseInt(days, 10));
  }

  @Get('profit')
  async getProfit() {
    const summary = await this.financialAi.getGlobalSummary();
    const taxEst  = this.tax.estimate({
      revenue:     summary.global.revenue,
      grossProfit: summary.global.profit,
    });
    return { summary: summary.global, tax: taxEst };
  }
}
