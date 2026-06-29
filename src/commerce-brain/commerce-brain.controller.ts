/**
 * CommerceBrainController — Admin-only intelligence endpoints
 *
 * Exposes Commerce Brain operations to admins for monitoring,
 * triggering cycles, and inspecting brain memory.
 */

import {
  Controller, Get, Post, Body, Param,
  Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { CommerceBrainService, BrainMemoryEntry } from './commerce-brain.service';
import { JwtAuthGuard }  from '../common/guards';
import { RolesGuard }    from '../common/guards';
import { Roles }         from '../common/decorators/roles.decorator';

@Controller('admin/commerce-brain')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class CommerceBrainController {

  constructor(private readonly brain: CommerceBrainService) {}

  /** Trigger a full commerce intelligence cycle for a tenant */
  @Post('cycle/:tenantId')
  @HttpCode(HttpStatus.ACCEPTED)
  async runCycle(@Param('tenantId') tenantId: string) {
    const plan = await this.brain.runCommerceCycle(tenantId);
    return { planId: plan.planId, status: plan.planStatus, estimatedRoas: plan.estimatedRoas };
  }

  /** Run TrendBrain standalone */
  @Get('trend/:tenantId')
  async getTrends(@Param('tenantId') tenantId: string) {
    return this.brain.trendBrain(tenantId);
  }

  /** Run ProductBrain standalone */
  @Get('products/:tenantId')
  async getProducts(@Param('tenantId') tenantId: string) {
    return this.brain.productBrain(tenantId);
  }

  /** Run AudienceBrain standalone */
  @Get('audiences/:tenantId')
  async getAudiences(@Param('tenantId') tenantId: string) {
    return this.brain.audienceBrain(tenantId);
  }

  /** Run CreativeBrain standalone */
  @Get('creatives/:tenantId')
  async getCreatives(@Param('tenantId') tenantId: string) {
    return this.brain.creativeBrain(tenantId);
  }

  /** Run SEOBrain for a niche */
  @Get('seo/:tenantId')
  async getSeoOpportunities(
    @Param('tenantId') tenantId: string,
    @Query('niche') niche = 'general e-commerce',
  ) {
    return this.brain.seoBrain(tenantId, niche);
  }

  /** Run SupplierBrain for a niche */
  @Get('supplier/:tenantId')
  async getSupplierRanking(
    @Param('tenantId') tenantId: string,
    @Query('niche') niche = 'general',
  ) {
    return this.brain.supplierBrain(tenantId, niche);
  }

  /** Recall brain memory */
  @Get('memory/:tenantId/:category')
  async recallMemory(
    @Param('tenantId') tenantId: string,
    @Param('category') category: BrainMemoryEntry['category'],
    @Query('limit') limit = '20',
  ) {
    return this.brain.recallMemory(tenantId, category, parseInt(limit, 10));
  }

  /** Manually submit a learning signal */
  @Post('memory/learn')
  @HttpCode(HttpStatus.CREATED)
  async learnFromOutcome(@Body() signal: BrainMemoryEntry) {
    await this.brain.learnFromOutcome(signal);
    return { ok: true };
  }

  /** Trigger memory consolidation now */
  @Post('memory/consolidate')
  @HttpCode(HttpStatus.ACCEPTED)
  async consolidate() {
    await this.brain.consolidateAllBrainMemory();
    return { ok: true };
  }
}
