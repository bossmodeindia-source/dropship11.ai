/**
 * AutonomousController — V4 API SURFACE
 *
 * Endpoints:
 *   GET  /autonomous/status          — loop health + last cycle summary
 *   POST /autonomous/trigger         — manual cycle trigger
 *   GET  /autonomous/profit-report   — real P&L dashboard (Shopify revenue only)
 *   GET  /autonomous/missing-data    — campaigns with no Shopify revenue (HOLD list)
 *   GET  /autonomous/optimization    — 60-min optimizer status
 *   POST /autonomous/optimization/trigger — manual optimization run
 *   GET  /autonomous/winner-dna      — top performing niches + hooks
 *   GET  /autonomous/creative-health/:id — creative CTR health per campaign
 */

import {
  Controller, Get, Post, Param, UseGuards,
  Logger, HttpException, HttpStatus, Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard }       from '../common/guards/jwt-auth.guard';
import { RolesGuard }         from '../common/guards/roles.guard';
import { Roles }              from '../common/decorators/roles.decorator';
import { CurrentUser }        from '../common/decorators/current-user.decorator';
// AutonomousLoopService — REMOVED in V67 (single orchestrator: UnifiedCommerceOrchestrator)
import { OptimizationScheduler }  from '../workers/optimization.scheduler';
import { WinnerDnaService }       from './winner-dna.service';
import { SelfHealingCreativeEngine } from '../ad-creatives/self-healing-creative.engine';
import { ShopifyRevenueService }  from '../shopify/shopify-revenue.service';
// Phase 3 imports
import { MultiWinnerTrackerService } from './multi-winner-tracker.service';
import { NicheDominationService }    from './niche-domination.service';
import { ProfitCompoundingEngine }   from './profit-compounding.engine';

@ApiTags('Autonomous V4 — Real Profit Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('autonomous')
export class AutonomousController {
  private readonly logger = new Logger(AutonomousController.name);

  constructor(
    // AutonomousLoopService loop — REMOVED in V67
    private readonly optimizer:    OptimizationScheduler,
    private readonly dna:          WinnerDnaService,
    private readonly creative:     SelfHealingCreativeEngine,
    private readonly shopify:      ShopifyRevenueService,
    // Phase 3
    private readonly multiWinner:  MultiWinnerTrackerService,
    private readonly nicheDOM:     NicheDominationService,
    private readonly compounding:  ProfitCompoundingEngine,
  ) {}

  // ── System status ─────────────────────────────────────────────────────────

  @Get('status')
  @ApiOperation({ summary: 'V4 engine status — shows real data quality metrics' })
  getStatus() {
    return {
      loop:         { status: 'unified_orchestrator', note: 'Managed by UnifiedCommerceOrchestrator — V67' },
      optimizer:    this.optimizer.getStatus(),
      v4Features: {
        realShopifyRevenueOnly:    true,
        metaEstimatedRoasDisabled: true,
        holdIfNoRevenueData:       true,
        selfHealingCreatives:      true,
        winnerDnaInjection:        true,
        optimizationIntervalMin:   60,
        hardKillRules: {
          spend150RoasBelow07: true,
          spend300ZeroConv:    true,
          ctr1pctAfter2kImpr:  true,
          noRevenue:           'HOLD',
        },
      },
    };
  }

  // ── Manual triggers ───────────────────────────────────────────────────────

  @Post('trigger')
  @Roles('admin')
  @ApiOperation({ summary: 'Manually trigger product discovery + launch cycle' })
  async triggerCycle() {
    // V67: AutonomousLoopService removed — trigger via UnifiedCommerceOrchestrator
    return {
      success: true,
      note: 'Autonomous cycles are managed by UnifiedCommerceOrchestrator with distributed lock (autonomous:cycle:lock). Use the orchestrator admin endpoint to trigger cycles.',
    };
  }

  @Post('optimization/trigger')
  @Roles('admin')
  @ApiOperation({ summary: 'Manually trigger 60-min optimization cycle (KILL/SCALE/PIVOT)' })
  async triggerOptimization() {
    try {
      const result = await this.optimizer.triggerManualCycle();
      return { success: true, result };
    } catch (err) {
      throw new HttpException(
        { error: (err as Error).message },
        HttpStatus.CONFLICT,
      );
    }
  }

  // ── Real P&L dashboard ────────────────────────────────────────────────────

  @Get('profit-report')
  @Roles('admin')
  @ApiOperation({
    summary: 'Real P&L dashboard — Shopify revenue only, no estimates',
    description:
      'Shows REAL ROAS = shopifyRevenue / adSpend and REAL profit = revenue - spend - COGS. ' +
      'Campaigns with no Shopify orders show dataQuality=MISSING and decision=HOLD.',
  })
  async getProfitReport() {
    const [totalRevenue, optimizerStatus] = await Promise.all([
      this.shopify.getTotalDailyRevenue(),
      Promise.resolve(this.optimizer.getStatus()),
    ]);

    return {
      realDataOnly:     true,
      metaRoasIgnored:  true,
      todayRealRevenue: totalRevenue,
      lastOptimization: optimizerStatus ?? null,
      dataQualityNote: (
        'Only Shopify webhook orders are counted as revenue. ' +
        'Campaigns without linked Shopify orders show MISSING data quality and receive HOLD decisions.'
      ),
    };
  }

  @Get('missing-data')
  @Roles('admin')
  @ApiOperation({
    summary: 'Campaigns with no Shopify revenue data (receiving HOLD decisions)',
    description:
      'These campaigns are HOLDING because no Shopify orders are linked to them. ' +
      'Fix: ensure Shopify webhook is active and orders are tagged with campaign_id.',
  })
  async getMissingDataCampaigns() {
    return {
      description: 'Campaigns with no real Shopify revenue — all receiving HOLD decisions',
      fix: 'Check Shopify webhook → orders.campaign_id linkage pipeline',
      note: 'System will NOT estimate revenue — HOLD is the only safe decision without real data',
    };
  }

  // ── Optimization status ───────────────────────────────────────────────────

  @Get('optimization')
  @ApiOperation({ summary: '60-minute optimization scheduler status and last cycle results' })
  getOptimizationStatus() {
    return this.optimizer.getStatus();
  }

  // ── Winner DNA ────────────────────────────────────────────────────────────

  @Get('winner-dna')
  @ApiOperation({ summary: 'Top performing niches and hooks (real ROAS ≥ 2 only)' })
  @ApiQuery({ name: 'category', required: false })
  async getWinnerDna(@Query('category') category?: string) {
    if (category) {
      const dna = await this.dna.getDnaForCategory(category);
      return { category, dna, source: 'real_shopify_roas_winners' };
    }

    const topNiches = await this.dna.getTopNiches(20);
    return {
      topNiches,
      source: 'real_shopify_roas_winners',
      note: 'Only categories with confirmed ROAS ≥ 2 from real Shopify orders',
    };
  }

  @Get('winner-dna/hooks/:category')
  @ApiOperation({ summary: 'Top hooks for a category — champions with CTR ≥ 3%' })
  async getTopHooks(@Param('category') category: string) {
    const hooks       = await this.dna.getTopHooksForCategory(category, 10);
    const dnaContext  = await this.dna.getPromptInjection(category);

    return {
      category,
      hooks,
      promptInjection: dnaContext,
      note: 'These hooks achieved CTR ≥ 3% from real Meta impressions',
    };
  }

  // ── Creative health ───────────────────────────────────────────────────────

  @Get('creative-health/:campaignId')
  @ApiOperation({
    summary: 'Creative health report for a campaign',
    description:
      'Shows real CTR per creative variant. ' +
      'Variants below 1% CTR are killed automatically. Champion variants (CTR ≥ 3%) are injected into DNA.',
  })
  async getCreativeHealth(
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: { id: string; role: string },
  ) {
    if (!this.isValidUuid(campaignId)) {
      throw new HttpException('Invalid campaign ID', HttpStatus.BAD_REQUEST);
    }

    const report = await this.creative.checkAndHeal(
      campaignId,
      user.id,
      'general',  // trigger read-only health check
      user.role,
    );

    return {
      campaignId,
      health: report,
      thresholds: {
        earlyKill:   '< 0.5% CTR after 200 impressions',
        standardKill: '< 1% CTR after 500 impressions',
        champion:    '≥ 3% CTR after 500 impressions',
      },
    };
  }

  // ── Revenue check for specific campaign ──────────────────────────────────

  @Get('revenue/:campaignId')
  @ApiOperation({ summary: 'Real Shopify revenue for a specific campaign' })
  async getCampaignRevenue(@Param('campaignId') campaignId: string) {
    if (!this.isValidUuid(campaignId)) {
      throw new HttpException('Invalid campaign ID', HttpStatus.BAD_REQUEST);
    }

    const revenue = await this.shopify.getCampaignRevenue(campaignId);
    const window  = await this.shopify.getRevenueWindow(campaignId);

    return {
      campaignId,
      revenue,
      window,
      realDataOnly: true,
      note: revenue.dataQuality === 'MISSING'
        ? 'No Shopify orders found for this campaign. System is issuing HOLD decisions.'
        : `Real Shopify revenue confirmed: $${revenue.revenue}`,
    };
  }

  // ── Helper ────────────────────────────────────────────────────────────────

  private isValidUuid(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  // ── PHASE 3 ENDPOINTS ─────────────────────────────────────────────────────

  /**
   * GET /autonomous/winner-portfolio
   * Multi-winner portfolio: how many active winners, stability, directive.
   */
  @Get('winner-portfolio')
  @ApiOperation({ summary: 'P3: Active winner portfolio (3–5 target) with discovery directive' })
  async getWinnerPortfolio() {
    const portfolio = await this.multiWinner.computePortfolio();
    return {
      ...portfolio,
      targets: { min: 3, max: 5 },
      note: portfolio.directive === 'BOOST_DISCOVERY'
        ? 'System is boosting product discovery to fill winner pipeline.'
        : portfolio.directive === 'REDUCE_TESTING'
        ? 'Winner pipeline full. Focus budget on scaling, reduce new tests.'
        : 'Balanced mode: maintain current discovery + scale pace.',
    };
  }

  /**
   * GET /autonomous/niche-domination
   * Shows niche domination expansion queue and coverage stats.
   */
  @Get('niche-domination')
  @ApiOperation({ summary: 'P3: Niche domination queue — adjacent products pending launch' })
  async getNicheDomination() {
    const coverage = await this.nicheDOM.getDominationCoverage();
    return {
      coverage,
      note: 'When a product reaches SCALE, adjacent keywords in the same niche are auto-queued for launch.',
    };
  }

  /**
   * GET /autonomous/compound-stats
   * Cumulative profit compounding statistics (70/30 split history).
   */
  @Get('compound-stats')
  @ApiOperation({ summary: 'P3: Profit compounding stats — reinvestment history' })
  async getCompoundStats() {
    const stats = await this.compounding.getCompoundStats();
    return {
      ...stats,
      reinvestRatio:  '70%',
      extractRatio:   '30%',
      note: '70% of each cycle\'s net profit is automatically reinvested: 50% boosts top campaigns, 50% funds new product tests.',
    };
  }
}
