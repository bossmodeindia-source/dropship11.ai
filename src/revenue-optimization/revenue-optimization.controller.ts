import {
  Controller, Get, Post, Body, Param, Req, UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards';
import { RevenueOptimizationService } from './revenue-optimization.service';

class GenerateUpsellDto {
  productName!:       string;
  currentPrice!:      number;
  upsellProductName!: string;
  upsellPrice!:       number;
}

class RecordPerformanceDto {
  converted!:   boolean;
  revenueLift!: number;
}

@UseGuards(JwtAuthGuard)
@Controller('api/v1/revenue-optimization')
export class RevenueOptimizationController {
  constructor(private readonly svc: RevenueOptimizationService) {}

  @Get('rules')
  async getRules(@Req() req: Request) {
    const tenantId = (req as any).tenantId;
    return this.svc.getActiveRules(tenantId);
  }

  @Post('discover')
  async discover(@Req() req: Request) {
    const tenantId = (req as any).tenantId;
    return this.svc.discoverForTenant(tenantId);
  }

  @Post('upsell-copy')
  async generateUpsell(@Req() req: Request, @Body() dto: GenerateUpsellDto) {
    const tenantId = (req as any).tenantId;
    return this.svc.generateUpsellCopy(
      tenantId, dto.productName, dto.currentPrice,
      dto.upsellProductName, dto.upsellPrice,
    );
  }

  @Post('rules/:id/performance')
  async recordPerformance(
    @Param('id') id: string,
    @Body() dto: RecordPerformanceDto,
  ) {
    await this.svc.recordRulePerformance(id, dto.converted, dto.revenueLift);
    return { success: true };
  }
}
