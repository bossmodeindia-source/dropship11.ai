import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SmartPricingEngine, PriceTestInput } from './smart-pricing.engine';

@UseGuards(JwtAuthGuard)
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricingEngine: SmartPricingEngine) {}

  /** GET /pricing/stats */
  @Get('stats')
  getStats(@CurrentUser() user: { id: string }) {
    return this.pricingEngine.getPricingStats(user.id);
  }

  /** POST /pricing/evaluate — evaluate if a product should get a price test */
  @Post('evaluate')
  evaluate(@CurrentUser() user: { id: string }, @Body() body: Omit<PriceTestInput, 'userId'>) {
    return this.pricingEngine.evaluatePriceTest({ ...body, userId: user.id });
  }

  /** POST /pricing/launch — launch a price test after evaluation */
  @Post('launch')
  launch(
    @CurrentUser() user: { id: string },
    @Body() body: { productId: string; decision: Parameters<SmartPricingEngine['launchTest']>[2]; currentRoas: number },
  ) {
    return this.pricingEngine.launchTest(user.id, body.productId, body.decision, body.currentRoas);
  }
}
