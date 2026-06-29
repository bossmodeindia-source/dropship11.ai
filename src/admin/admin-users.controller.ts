/**
 * AdminUsersController
 *
 * User management endpoints accessible to admin and superadmin roles.
 *
 * BUG FIX (V64-Bug2):
 *   - Added explicit @UseGuards(JwtAuthGuard, RolesGuard) at class level.
 *     Previously relied solely on the global APP_GUARD with no local fallback.
 *
 * BUG FIX (V64-Warning2):
 *   - Class-level @Roles was 'admin' only; changed to 'admin', 'superadmin'
 *     to match the codebase-wide convention for admin-tier routes.
 */

import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AdminUsersService } from './admin-users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@ApiTags('Admin — Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)   // FIX: explicit guards — no longer relies solely on APP_GUARD
@Roles('admin', 'superadmin')          // FIX: superadmin added to match codebase convention
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Platform-wide user statistics' })
  getStats() {
    return this.adminUsers.getStats();
  }

  @Get()
  @ApiOperation({ summary: 'List all users (paginated, optional search)' })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    return this.adminUsers.findAll(page, Math.min(limit, 200), search);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single user by ID' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminUsers.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update user profile / role / status' })
  updateUser(
    @CurrentUser() actor: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.adminUsers.updateUser(id, dto, actor.sub);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a user account' })
  suspend(
    @CurrentUser() actor: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminUsers.suspendUser(actor.sub, id);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended user account' })
  reactivate(
    @CurrentUser() actor: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminUsers.reactivateUser(actor.sub, id);
  }

  @Patch(':id/subscription')
  @ApiOperation({ summary: 'Update a user subscription plan / limits' })
  updateSubscription(
    @CurrentUser() actor: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubscriptionDto,
  ) {
    return this.adminUsers.updateSubscription(id, dto, actor.sub);
  }

  @Get(':id/audit-log')
  @ApiOperation({ summary: 'Get audit log entries for a specific user' })
  getAuditLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.adminUsers.getUserAuditLog(id, page, Math.min(limit, 100));
  }
}
