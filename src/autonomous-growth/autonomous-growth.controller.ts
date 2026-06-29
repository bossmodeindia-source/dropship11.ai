import {
  Controller, Get, Post, Body, Req, UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards';
import { AutonomousGrowthService } from './autonomous-growth.service';

class RecordViralShareDto {
  productId!:         string;
  sourceChannel!:     string;
  attributedRevenue!: number;
}

@UseGuards(JwtAuthGuard)
@Controller('api/v1/growth')
export class AutonomousGrowthController {
  constructor(private readonly growth: AutonomousGrowthService) {}

  @Get('health')
  async growthHealth(@Req() req: Request) {
    const tenantId = (req as any).tenantId;
    return this.growth.getGrowthHealth(tenantId);
  }

  @Post('loops/run')
  async runLoops(@Req() req: Request) {
    const tenantId = (req as any).tenantId;
    return this.growth.runLoopsForTenant(tenantId);
  }

  @Post('viral-share')
  async recordViralShare(@Req() req: Request, @Body() dto: RecordViralShareDto) {
    const tenantId = (req as any).tenantId;
    await this.growth.recordViralShare(
      tenantId, dto.productId, dto.sourceChannel, dto.attributedRevenue,
    );
    return { recorded: true };
  }
}
