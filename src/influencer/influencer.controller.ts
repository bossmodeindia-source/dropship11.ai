import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { InfluencerService, Platform, DealType, ReplyStatus } from './influencer.service';

@UseGuards(JwtAuthGuard)
@Controller('influencers')
export class InfluencerController {
  constructor(private readonly influencerService: InfluencerService) {}

  /** GET /influencers/stats */
  @Get('stats')
  getStats(@CurrentUser() user: { id: string }) {
    return this.influencerService.getInfluencerStats(user.id);
  }

  /** GET /influencers/suggest?niche=fitness&platform=instagram */
  @Get('suggest')
  suggest(@Query('niche') niche: string, @Query('platform') platform: Platform, @Query('count') count?: string) {
    return this.influencerService.suggestInfluencers(niche, platform, count ? parseInt(count, 10) : 5);
  }

  /** POST /influencers — add to pipeline + generate outreach */
  @Post()
  add(
    @CurrentUser() user: { id: string },
    @Body() body: {
      brandId?: string; niche: string; platform: Platform; handle: string;
      followerCount?: number; engagementRate?: number; contactEmail?: string;
      dealType: DealType; commissionPct: number; brandName: string; productTitle: string;
    },
  ) {
    return this.influencerService.addInfluencer({ ...body, userId: user.id });
  }

  /** PATCH /influencers/:id/status */
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { outreachSent?: boolean; replyStatus?: ReplyStatus },
  ) {
    return this.influencerService.updateOutreachStatus(id, body.outreachSent ?? false, body.replyStatus);
  }
}
