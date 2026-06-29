import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RetentionService } from './retention.service';

@UseGuards(JwtAuthGuard)
@Controller('retention')
export class RetentionController {
  constructor(private readonly retentionService: RetentionService) {}

  /** GET /retention/summary */
  @Get('summary')
  getSummary(@CurrentUser() user: { id: string }) {
    return this.retentionService.getRetentionSummary(user.id);
  }

  /** POST /retention/brands/:brandId/init-flows */
  @Post('brands/:brandId/init-flows')
  initFlows(
    @CurrentUser() user: { id: string },
    @Param('brandId') brandId: string,
    @Body() body: { brandName: string; productTitle: string; niche: string },
  ) {
    return this.retentionService.initFlowsForBrand(
      user.id, brandId, body.brandName, body.productTitle, body.niche,
    );
  }

  /** POST /retention/events/:flowId/engage */
  @Post('events/:flowId/engage')
  recordEngagement(
    @Param('flowId') flowId: string,
    @Body() body: { customerId: string; event: 'open' | 'click' | 'convert'; revenue?: number },
  ) {
    return this.retentionService.recordEngagement(flowId, body.customerId, body.event, body.revenue);
  }
}
