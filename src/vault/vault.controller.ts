/**
 * VaultController — V59 API Key Vault
 *
 * Routes:
 *   GET    /vault               — list credentials (metadata only)
 *   POST   /vault               — store/update credential
 *   DELETE /vault/:keyName      — delete credential
 *   POST   /vault/rotate-key    — admin: rotate master encryption key
 *
 * NEVER returns plaintext credential values via HTTP.
 * Decryption is internal-only (VaultService.decrypt called from services).
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsDateString, MinLength } from 'class-validator';
import { VaultService, VaultProvider } from './vault.service';
import { TenantId, UserId } from '../tenant/tenant.guard';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';

export class StoreCredentialDto {
  @IsString()
  keyName!: string;

  @IsEnum(['meta', 'shopify', 'openai', 'tiktok', 'google', 'telegram', 'sendgrid', 'other'])
  provider!: VaultProvider;

  @IsString()
  @MinLength(4)
  value!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class RotateKeyDto {
  @IsString()
  @MinLength(64)
  oldKeyHex!: string;

  @IsString()
  @MinLength(64)
  newKeyHex!: string;
}

@ApiTags('Vault')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vault')
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Get()
  @ApiOperation({ summary: 'List stored credentials (metadata only)' })
  async list(@TenantId() tenantId: string) {
    return this.vault.list(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Store or update a credential' })
  async store(
    @TenantId() tenantId: string,
    @UserId() userId: string,
    @Body() dto: StoreCredentialDto,
  ) {
    return this.vault.store(
      tenantId,
      dto.keyName,
      dto.provider,
      dto.value,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      userId,
    );
  }

  @Delete(':keyName')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a credential' })
  async delete(
    @TenantId() tenantId: string,
    @UserId() userId: string,
    @Param('keyName') keyName: string,
  ) {
    await this.vault.delete(tenantId, keyName, userId);
  }

  @Post('rotate-key')
  @Roles('superadmin')
  @ApiOperation({ summary: 'Admin: rotate master encryption key' })
  async rotateKey(@UserId() adminId: string, @Body() dto: RotateKeyDto) {
    return this.vault.rotateMasterKey(dto.oldKeyHex, dto.newKeyHex, adminId);
  }
}
