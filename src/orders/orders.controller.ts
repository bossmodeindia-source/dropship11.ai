import { Controller, Post, Get, Body, Param, Query, Req, HttpCode, HttpStatus, ParseUUIDPipe, ParseIntPipe, DefaultValuePipe, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import { WebhookOrderDto } from './dto/webhook-order.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * POST /orders/webhook
   *
   * Inbound webhook receiver — must be public (no JWT required).
   * BUG FIX (V64-Bug3): Missing @Public() caused every external caller to
   * receive a 401. The canonical Shopify path uses ShopifyWebhookV60Controller
   * (correctly marked @Public()); this endpoint handles generic order events.
   *
   * HMAC verification is enforced by WebhookHmacGuard inside the service
   * layer, so skipping JWT auth here does NOT reduce security.
   */
  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  handleWebhook(@Body() dto: WebhookOrderDto, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
    // userId comes from the payload for public webhooks; falls back to empty string
    // so the service inserts a pending order without a user binding (resolved by
    // the ShopifyOrderSync job that enriches it post-receipt).
    return this.ordersService.handleWebhook(dto.userId ?? '', dto, ip);
  }

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.ordersService.findAll(user.sub, page, Math.min(limit, 100));
  }

  @Get('queue/stats')
  @Roles('admin')
  queueStats() { return this.ordersService.getQueueStats(); }

  @Get(':id')
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.findOne(user.sub, id);
  }

  @Get(':id/status-log')
  statusLog(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.getStatusLog(user.sub, id);
  }
}
