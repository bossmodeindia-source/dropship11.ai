/**
 * CommerceController
 *
 * All routes for the Final Execution Commerce Layer.
 *
 * Products
 *   POST /products/discover           → Trigger V46 discovery
 *   POST /products/:id/approve        → User approves + sets price + mode
 *   POST /products/:id/reject         → User rejects product
 *   GET  /products/pending            → List products awaiting approval
 *
 * Shopify
 *   POST /shopify/create-product      → Create product on Shopify
 *   POST /webhooks/shopify/orders/paid → Webhook (handled in ShopifyWebhookV60Controller)
 *
 * Campaigns
 *   POST /campaigns/launch            → Launch paid/organic/hybrid
 *   POST /campaigns/:id/scale         → Scale a campaign
 *   POST /campaigns/:id/pause         → Pause a campaign
 *   POST /campaigns/generate-launch   → Creatives → Score → Launch
 *
 * Orders
 *   GET  /orders                      → List all orders
 *   POST /orders/pay-supplier         → Pay supplier for order
 *   GET  /orders/supplier-payments    → List supplier payments
 *
 * Dashboard
 *   GET  /commerce/dashboard          → Summary dashboard
 *   POST /commerce/pipeline/run       → Manually trigger pipeline (dev/admin)
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus
} from '@nestjs/common';
import { CommercePipelineService } from './commerce-pipeline.service';
import {
  ApproveProductDto,
  RejectProductDto,
  CreateShopifyProductDto,
  GenerateAndLaunchDto,
  PaySupplierDto,
  RunPipelineDto,
} from './dto/commerce.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

// ── Products ──────────────────────────────────────────────────────────────────

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsCommerceController {
  constructor(private readonly pipeline: CommercePipelineService) {}

  /** GET /products/pending — products awaiting user approval */
  @Get('pending')
  getPendingApprovals(@CurrentUser() user: JwtPayload) {
    return this.pipeline.getPendingApprovals(user.sub);
  }

  /** POST /products/:id/approve — user approves a discovered product */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approveProduct(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Omit<ApproveProductDto, 'productId'>,
  ) {
    return this.pipeline.approveProduct(user.sub, { ...dto, productId: id });
  }
}

// ── Shopify ───────────────────────────────────────────────────────────────────

@Controller('shopify')
@UseGuards(JwtAuthGuard)
export class ShopifyCommerceController {
  constructor(private readonly pipeline: CommercePipelineService) {}

  /** POST /shopify/create-product — push approved product to Shopify */
  @Post('create-product')
  @HttpCode(HttpStatus.CREATED)
  createProduct(@CurrentUser() user: JwtPayload, @Body() dto: CreateShopifyProductDto) {
    return this.pipeline.createShopifyProduct(user.sub, dto.productId);
  }
}

// ── Campaign Execution ────────────────────────────────────────────────────────

@Controller('campaigns')
@UseGuards(JwtAuthGuard)
export class CampaignExecutionController {
  constructor(private readonly pipeline: CommercePipelineService) {}

  /** POST /campaigns/generate-launch — full creative → score → launch flow */
  @Post('generate-launch')
  @HttpCode(HttpStatus.CREATED)
  generateAndLaunch(@CurrentUser() user: JwtPayload, @Body() dto: GenerateAndLaunchDto) {
    return this.pipeline.generateAndLaunch(user.sub, dto);
  }
}

// ── Orders ────────────────────────────────────────────────────────────────────

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersCommerceController {
  constructor(private readonly pipeline: CommercePipelineService) {}

  /** GET /orders — list all orders */
  @Get()
  listOrders(@CurrentUser() user: JwtPayload) {
    return this.pipeline.listOrders(user.sub);
  }

  /** POST /orders/pay-supplier — mark supplier as paid, unlock fulfillment */
  @Post('pay-supplier')
  @HttpCode(HttpStatus.OK)
  paySupplier(@CurrentUser() user: JwtPayload, @Body() dto: PaySupplierDto) {
    return this.pipeline.paySupplier(user.sub, dto);
  }

  /** GET /orders/supplier-payments — list all supplier payments */
  @Get('supplier-payments')
  getSupplierPayments(@CurrentUser() user: JwtPayload) {
    return this.pipeline.getSupplierPayments(user.sub);
  }
}

// ── Dashboard + Pipeline ──────────────────────────────────────────────────────

@Controller('commerce')
@UseGuards(JwtAuthGuard)
export class CommerceDashboardController {
  constructor(private readonly pipeline: CommercePipelineService) {}

  /** GET /commerce/dashboard — profit summary for current user */
  @Get('dashboard')
  getDashboard(@CurrentUser() user: JwtPayload) {
    return this.pipeline.getDashboardSummary(user.sub);
  }

  /** POST /commerce/pipeline/run — manually trigger pipeline (admin/dev) */
  @Post('pipeline/run')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  runPipeline(@Body() dto: RunPipelineDto) {
    return this.pipeline.runCommercePipeline(dto.botId);
  }
}
