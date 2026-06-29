import {
  Controller, Get, Post, Body, HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { SupplierRoutingEngine, RoutingInput } from './supplier-routing-engine.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin/supplier-routing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class SupplierRoutingController {

  constructor(private readonly engine: SupplierRoutingEngine) {}

  @Get('rankings')
  async getRankings() {
    return this.engine.getSupplierRankings('platform');
  }

  @Post('test-route')
  @HttpCode(HttpStatus.OK)
  async testRoute(@Body() input: RoutingInput) {
    return this.engine.routeOrder(input);
  }

  @Post('record-outcome')
  @HttpCode(HttpStatus.OK)
  async recordOutcome(
    @Body() body: {
      supplier: any;
      success: boolean;
      daysToShip: number;
      tenantId: string;
    },
  ) {
    await this.engine.recordFulfillmentOutcome(
      body.supplier,
      body.success,
      body.daysToShip,
      body.tenantId,
    );
    return { ok: true };
  }
}
