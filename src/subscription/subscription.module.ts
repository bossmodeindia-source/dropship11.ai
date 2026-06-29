/**
 * SubscriptionController
 *
 * Routes:
 *   GET  /billing/subscription         — Get current plan status
 *   POST /billing/subscription/create  — Create PRO or ELITE subscription
 *   POST /billing/subscription/cancel  — Cancel subscription
 *   POST /billing/webhook/razorpay     — Razorpay webhook (public, signature-verified)
 *
 * Admin routes:
 *   PATCH /admin/subscriptions/:userId/plan — Override plan (admin/super_admin)
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Request,
  RawBodyRequest,
  Headers,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SkipTenantGuard } from '../tenant/tenant.guard';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantId } from '../tenant/tenant.guard';
import { SubscriptionService } from './subscription.service';
import {
  CreateSubscriptionDto,
  CancelSubscriptionDto,
} from './dto/subscription.dto';

@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('billing')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('subscription')
  @Roles('user', 'admin', 'superadmin')
  @ApiOperation({ summary: 'Get current subscription plan status' })
  async getStatus(@Request() req: any, @TenantId() tenantId: string) {
    return this.subscriptionService.getStatus(req.user.id, tenantId);
  }

  @Post('subscription/create')
  @Roles('user', 'admin', 'superadmin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or upgrade to PRO/ELITE plan via Razorpay' })
  async create(
    @Request() req: any,
    @TenantId() tenantId: string,
    @Body() dto: CreateSubscriptionDto,
  ) {
    return this.subscriptionService.createOrUpgrade(
      req.user.id, tenantId, dto.plan, req.ip,
    );
  }

  @Post('subscription/cancel')
  @Roles('user', 'admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel current subscription' })
  async cancel(
    @Request() req: any,
    @TenantId() tenantId: string,
    @Body() dto: CancelSubscriptionDto,
  ) {
    await this.subscriptionService.cancel(
      req.user.id, tenantId, dto.immediate ?? false, req.ip,
    );
    return { message: 'Subscription cancellation initiated' };
  }
}

// ── Webhook Controller (public — no JWT, signature-verified internally) ────────

@ApiTags('Webhooks')
@Controller('billing/webhook')
export class RazorpaySubscriptionBillingWebhookController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Post('razorpay')
  @SkipTenantGuard()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay subscription webhook receiver (signature-verified)' })
  async handleRazorpayWebhook(
    @Headers('x-razorpay-signature') signature: string,
    @Body() body: any,
    @Request() req: RawBodyRequest<any>,
  ) {
    // rawBody must be enabled in main.ts: app.use(express.raw({ type: 'application/json' }))
    const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(body);
    await this.subscriptionService.handleWebhook(rawBody, signature);
    return { received: true };
  }
}

// ── Admin Subscription Controller ─────────────────────────────────────────────

@ApiTags('Admin — Subscriptions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/subscriptions')
export class AdminSubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get(':userId')
  @Roles('admin', 'superadmin')
  @ApiOperation({ summary: 'Get subscription status for any user (admin)' })
  async getForUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @TenantId() tenantId: string,
  ) {
    return this.subscriptionService.getStatus(userId, tenantId);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { AuditModule } from '../audit/audit.module';
import { PlanGuard } from './plan.guard';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [
    SubscriptionController,
    RazorpaySubscriptionBillingWebhookController,
    AdminSubscriptionController,
  ],
  providers: [SubscriptionService, PlanGuard],
  exports:   [SubscriptionService, PlanGuard],
})
export class SubscriptionModule {}
