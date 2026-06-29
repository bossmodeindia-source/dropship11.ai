import {
  Controller, Get, Post, Body, Query, Req, UseGuards, Param,
} from '@nestjs/common';

import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { CustomerLifecycleService } from './customer-lifecycle.service';

class GenerateCampaignDto {
  segment!:       string;
  channel!:       'email' | 'whatsapp';
  brandContext?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('api/v1/lifecycle')
export class CustomerLifecycleController {
  constructor(private readonly lifecycle: CustomerLifecycleService) {}

  @Get('segments/summary')
  async segmentSummary(@Req() req: Request) {
    const tenantId = (req as any).tenantId;
    return this.lifecycle.getSegmentSummary(tenantId);
  }

  @Get('at-risk')
  async atRisk(@Req() req: Request, @Query('limit') limit = 50) {
    const tenantId = (req as any).tenantId;
    return this.lifecycle.getAtRiskCustomers(tenantId, +limit);
  }

  @Post('campaigns/generate')
  async generateCampaign(@Req() req: Request, @Body() dto: GenerateCampaignDto) {
    const tenantId = (req as any).tenantId;
    const campaignId = await this.lifecycle.generateLifecycleCampaign(
      tenantId, dto.segment as any, dto.channel, dto.brandContext,
    );
    return { campaignId };
  }
}
