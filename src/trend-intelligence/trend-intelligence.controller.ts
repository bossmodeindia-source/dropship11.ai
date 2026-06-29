import {
  Controller, Get, Post, HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { TrendIntelligenceService } from './trend-intelligence.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin/trend-intelligence')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class TrendIntelligenceController {

  constructor(private readonly trends: TrendIntelligenceService) {}

  @Post('harvest')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerHarvest() {
    const report = await this.trends.harvestTrendSignals();
    return {
      generatedAt:       report.generatedAt,
      signalsCollected:  report.signalsCollected,
      viralOpportunities: report.viralOpportunities.length,
      topKeywords:        report.topKeywords,
    };
  }

  @Get('latest')
  async getLatest() {
    return this.trends.getLatestTrends(50);
  }

  @Get('viral-opportunities')
  async getViralOpportunities() {
    return this.trends.getViralOpportunities();
  }
}
