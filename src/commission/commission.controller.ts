/**
 * CommissionController — Admin-only
 *
 * All routes are admin-protected. Commission amounts are NEVER
 * exposed in user-facing responses — only minimumAllowedPrice is visible to users.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CommissionService } from './commission.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

class UpsertCommissionDto {
  isEnabled!:          boolean;
  commissionType!:     'fixed' | 'percentage';
  fixedAmount?:        number;
  percentage?:         number;
  appliedToCategory?:  string;
  minOrderValue?:      number;
  notes?:              string;
}

@Controller('admin/commission')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class CommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  /** GET /admin/commission — read current config */
  @Get()
  getConfig() {
    return this.commissionService.getConfig();
  }

  /** POST /admin/commission — create or update commission rules */
  @Post()
  @HttpCode(HttpStatus.OK)
  upsertConfig(
    @CurrentUser() admin: JwtPayload,
    @Body() dto: UpsertCommissionDto,
  ) {
    return this.commissionService.upsertConfig(admin.sub, dto);
  }
}
