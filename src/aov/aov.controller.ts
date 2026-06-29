import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AovService, BundleInput, UpsellInput } from './aov.service';

@UseGuards(JwtAuthGuard)
@Controller('aov')
export class AovController {
  constructor(private readonly aovService: AovService) {}

  /** GET /aov/stats — AOV performance stats */
  @Get('stats')
  getStats(@CurrentUser() user: { id: string }) {
    return this.aovService.getAovStats(user.id);
  }

  /** POST /aov/bundles — create bundles for a product set */
  @Post('bundles')
  createBundles(@CurrentUser() user: { id: string }, @Body() body: Omit<BundleInput, 'userId'>) {
    return this.aovService.createBundles({ ...body, userId: user.id });
  }

  /** POST /aov/upsells — create upsell rule */
  @Post('upsells')
  createUpsell(@CurrentUser() user: { id: string }, @Body() body: Omit<UpsellInput, 'userId'>) {
    return this.aovService.createUpsellRule({ ...body, userId: user.id });
  }

  /** POST /aov/upsells/:id/interaction — record impression/accept */
  @Post('upsells/:id/interaction')
  recordInteraction(
    @Param('id') id: string,
    @Body() body: { accepted: boolean; revenueAdded?: number },
  ) {
    return this.aovService.recordUpsellInteraction(id, body.accepted, body.revenueAdded);
  }
}
