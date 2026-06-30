/**
 * AiProviderRegistryController — ADMIN ONLY
 *
 * All routes require: JWT + Admin role.
 * Users never reach these endpoints.
 */

import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards, Request,
  ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AiProviderRegistryService } from './ai-provider-registry.service';
import {
  CreateProviderDto,
  UpdateProviderDto,
  ApproveProviderDto,
  DisableProviderDto,
  ImportProvidersDto,
} from './dto/provider-registry.dto';
import { JwtAuthGuard } from '../common/guards';
import { Roles }        from '../common/decorators/roles.decorator';
import { RolesGuard }   from '../common/guards';

@Controller('admin/ai-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AiProviderRegistryController {
  constructor(private readonly registry: AiProviderRegistryService) {}

  /** List ALL providers (any status) — admin view */
  @Get()
  async listAll() {
    return this.registry.listAllProviders();
  }

  /** Create a new provider (status: pending until approved) */
  @Post()
  async createProvider(
    @Body() dto: CreateProviderDto,
    @Request() req: any,
  ) {
    return this.registry.createProvider(dto, req.user.id);
  }

  /** Approve a pending provider — makes it available for user connections */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approveProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveProviderDto,
    @Request() req: any,
  ) {
    return this.registry.approveProvider(id, dto, req.user.id);
  }

  /** Disable a provider — kills all user connections to it */
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disableProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisableProviderDto,
    @Request() req: any,
  ) {
    await this.registry.disableProvider(id, dto.reason, req.user.id);
    return { message: 'Provider disabled', providerId: id };
  }

  /** Update provider metadata */
  @Patch(':id')
  async updateProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProviderDto,
    @Request() req: any,
  ) {
    return this.registry.updateProvider(id, dto, req.user.id);
  }

  /** Soft-delete/deprecate a provider without breaking audit history */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    await this.registry.deleteProvider(id, req.user.id);
    return { message: 'Provider deprecated', providerId: id };
  }

  /** Test configured health/API connectivity with masked credentials */
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  async testProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    return this.registry.testProviderConnectivity(id, req.user.id);
  }

  /** Export provider metadata; platform API keys are never exported */
  @Get('export')
  async exportProviders(@Request() req: any) {
    return this.registry.exportProviders(req.user.id);
  }

  /** Import provider metadata from an admin-provided JSON payload */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  async importProviders(
    @Body() dto: ImportProvidersDto,
    @Request() req: any,
  ) {
    return this.registry.importProviders(dto, req.user.id);
  }

  /** Health summary across all providers */
  @Get('health')
  async getHealthSummary() {
    return this.registry.getProviderHealthSummary();
  }
}

/** Separate public controller for user-facing provider list */
@Controller('api/v1/ai-providers')
@UseGuards(JwtAuthGuard)
export class AiProviderPublicController {
  constructor(private readonly registry: AiProviderRegistryService) {}

  /** List ONLY approved providers — what users can connect their keys to */
  @Get('available')
  async listAvailable() {
    const providers = await this.registry.listApprovedProviders();
    // Strip internal fields; never expose sdkClass or internal details
    return providers.map(p => ({
      id:                   p.id,
      providerKey:          p.providerKey,
      displayName:          p.displayName,
      category:             p.category,
      description:          p.description,
      logoUrl:              p.logoUrl,
      providerType:         p.providerType,
      docsUrl:              p.docsUrl,
      requiresSecondaryKey: p.requiresSecondaryKey,
      secondaryKeyLabel:    p.secondaryKeyLabel,
      capabilities:         p.capabilities,
      supportedModels:      p.supportedModels,
      defaultModel:         p.defaultModel,
      features: {
        streaming:          p.supportsStreaming,
        vision:             p.supportsVision,
        imageGeneration:    p.supportsImageGeneration,
        functionCalling:    p.supportsFunctionCalling,
        jsonMode:           p.supportsJsonMode,
      },
      status:               p.healthStatus,
      byokEnabled:          p.byokEnabled,
      pricingUnit:          p.pricingUnit,
    }));
  }
}
