/**
 * AdminKeysController
 *
 * Runtime API key management — inject, rotate, or inspect any provider key
 * without restarting the application.
 *
 * All endpoints are admin-only (JwtAuthGuard + RolesGuard).
 * Keys are AES-256-GCM encrypted in DB; this API never returns raw values.
 *
 * POST /admin/keys/set    — inject a new key value
 * POST /admin/keys/rotate — atomically rotate to a new value
 * GET  /admin/keys/status — check availability of all providers
 */

import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigVaultService, ProviderKey } from '../config-vault/config-vault.service';
import { CircuitBreakerService } from '../ai-orchestrator/circuit-breaker.service';
import { JwtAuthGuard  } from '../common/guards/jwt-auth.guard';
import { RolesGuard    } from '../common/guards/roles.guard';
import { Roles         } from '../common/decorators/roles.decorator';
import { SetKeyDto     } from './dto/set-key.dto';
import { RotateKeyDto  } from './dto/rotate-key.dto';

@Controller('admin/keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class AdminKeysController {
  private readonly logger = new Logger(AdminKeysController.name);

  constructor(
    private readonly vault:   ConfigVaultService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  /**
   * POST /admin/keys/set
   * Inject a new API key for a provider. Takes effect on next request (cache TTL).
   */
  @Post('set')
  @HttpCode(HttpStatus.OK)
  async setKey(@Body() dto: SetKeyDto): Promise<{ success: boolean; provider: string }> {
    this.logger.log(`[AdminKeys] Setting key for ${dto.provider}`);

    await this.vault.set(dto.provider as ProviderKey, dto.value, 'admin');

    // Reset circuit breaker so the newly-keyed provider can be probed immediately
    await this.resetProviderBreaker(dto.provider);

    return { success: true, provider: dto.provider };
  }

  /**
   * POST /admin/keys/rotate
   * Atomically replace a provider key. Old value overwritten, cache busted.
   */
  @Post('rotate')
  @HttpCode(HttpStatus.OK)
  async rotateKey(@Body() dto: RotateKeyDto): Promise<{ success: boolean; provider: string }> {
    this.logger.log(`[AdminKeys] Rotating key for ${dto.provider}`);

    await this.vault.rotate(dto.provider as ProviderKey, dto.newValue);
    await this.resetProviderBreaker(dto.provider);

    return { success: true, provider: dto.provider };
  }

  /**
   * GET /admin/keys/status
   * Returns availability status for all configured providers.
   * Does NOT expose raw key values.
   */
  @Get('status')
  async getStatus(): Promise<{
    providers:       Record<string, { available: boolean; source: string; updatedAt?: Date }>;
    circuitBreakers: import('../ai-orchestrator/circuit-breaker.service').CircuitStatus[];
    systemMode:      'MOCK' | 'PARTIAL' | 'FULL';
  }> {
    const [providers, circuitBreakers] = await Promise.all([
      this.vault.getStatus(),
      this.breaker.getFullStatus(),
    ]);

    const systemMode = this.deriveSystemMode(providers);

    return { providers, circuitBreakers, systemMode };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async resetProviderBreaker(provider: string): Promise<void> {
    if (provider.includes('49B'))  await this.breaker.recordSuccess('nvidia_49b');
    if (provider.includes('253B')) await this.breaker.recordSuccess('nvidia_253b');
    if (provider.includes('MUAPI'))    await this.breaker.recordSuccess('muapi');
  }

  private deriveSystemMode(
    providers: Awaited<ReturnType<ConfigVaultService['getStatus']>>,
  ): 'MOCK' | 'PARTIAL' | 'FULL' {
    const criticalKeys: ProviderKey[] = [
      'NVIDIA_49B_API_KEY',
      'NVIDIA_253B_API_KEY',
      'MUAPI_API_KEY',
    ];

    const available = criticalKeys.filter(k => providers[k]?.available).length;

    if (available === 0)             return 'MOCK';
    if (available < criticalKeys.length) return 'PARTIAL';
    return 'FULL';
  }
}
