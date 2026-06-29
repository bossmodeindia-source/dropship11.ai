/**
 * WalletController
 *
 * User-facing wallet API. Protected by JWT auth guard (global).
 *
 * GET  /wallet              → current balance
 * GET  /wallet/transactions → ledger history
 * POST /wallet/admin/refund → admin manually triggers refund for an order
 *
 * BUG FIX (V64): req.user.id → req.user.sub everywhere.
 *   JWT payload uses `sub` as the canonical user identifier.
 *   Using `id` returned undefined, breaking all three wallet endpoints.
 */

import {
  Controller, Get, Post, Body, UseGuards,
  Query, ParseIntPipe, DefaultValuePipe,
  HttpCode, HttpStatus, Logger, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsPositive, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { WalletService } from './wallet.service';
import { OrderRefundService } from './order-refund.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

// ── DTOs ────────────────────────────────────────────────────────────────────

export class AdminRefundDto {
  @IsUUID()
  orderId!: string;

  @IsString()
  reason!: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  partialAmount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('wallet')
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(
    private readonly wallet:    WalletService,
    private readonly refundSvc: OrderRefundService,
  ) {}

  // ── GET /wallet — current balance ──────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Get current wallet balance' })
  async getBalance(@CurrentUser() user: JwtPayload) {
    // FIX: was req.user.id (undefined) — JWT payload uses user.sub
    const balance = await this.wallet.getBalance(user.sub);
    return {
      balance:  balance.balance,
      currency: balance.currency,
      message:  balance.balance > 0
        ? `You have ₹${balance.balance} available in your wallet`
        : 'Your wallet is empty',
    };
  }

  // ── GET /wallet/transactions — ledger history ─────────────────────────────

  @Get('transactions')
  @ApiOperation({ summary: 'Get wallet transaction history' })
  async getTransactions(
    @CurrentUser() user: JwtPayload,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    // FIX: was req.user.id (undefined) — JWT payload uses user.sub
    const transactions = await this.wallet.getTransactions(
      user.sub,
      Math.min(limit, 100),
    );

    return {
      transactions: transactions.map(tx => ({
        id:           tx.id,
        type:         tx.type,
        status:       tx.status,
        amount:       tx.amount,      // positive = credit, negative = debit
        balanceAfter: tx.balanceAfter,
        currency:     tx.currency,
        description:  tx.description,
        orderId:      tx.orderId,
        date:         tx.createdAt,
      })),
      count: transactions.length,
    };
  }

  // ── POST /wallet/admin/refund — admin manual refund trigger ───────────────

  @Post('admin/refund')
  @Roles('admin', 'superadmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Manually trigger refund for an order' })
  async adminRefund(
    @Body() dto: AdminRefundDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    if (!dto.orderId) throw new BadRequestException('orderId is required');
    if (!dto.reason)  throw new BadRequestException('reason is required');

    // FIX: was req.user.id (undefined) — JWT payload uses actor.sub
    const result = await this.refundSvc.refundOrder({
      orderId:       dto.orderId,
      reason:        dto.reason,
      partialAmount: dto.partialAmount,
      adminId:       actor.sub,
    });

    this.logger.log(
      `Admin refund | admin=${actor.sub} | order=${dto.orderId} | ₹${result.refundAmount}`,
    );

    return {
      success:         true,
      refundAmount:    result.refundAmount,
      gatewayRefundId: result.gatewayRefundId,
      walletTxId:      result.walletTxId,
      walletBalance:   result.walletBalance,
      message:         `₹${result.refundAmount} refunded successfully. Customer wallet updated.`,
    };
  }
}
