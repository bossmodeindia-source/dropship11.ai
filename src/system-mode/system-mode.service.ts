/**
 * SystemModeService — V59 Global System State Controller
 *
 * System modes:
 *   normal      — full operation, all features enabled
 *   degraded    — some features disabled (e.g., external APIs down)
 *   safe        — all autonomous execution paused, read-only
 *   maintenance — all user traffic blocked, admin-only access
 *
 * Mode is stored in Redis (fast reads) + DB (persistent audit trail).
 * All mode changes are audit-logged with actor + reason.
 *
 * Admin controls:
 *   - Global pause ads
 *   - Global disable organic posting
 *   - Freeze user(s)
 *   - Freeze supplier(s)
 *   - Override pricing
 *   - Enable maintenance mode
 */

import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { DB_POOL } from '../common/database/database.module';

export type SystemMode = 'normal' | 'degraded' | 'safe' | 'maintenance';

export interface SystemState {
  mode: SystemMode;
  reason: string;
  changedAt: Date;
  changedBy: string;
  globalAdsEnabled: boolean;
  globalOrganicEnabled: boolean;
  maintenanceMessage?: string;
}

const SYSTEM_STATE_KEY = 'system:state';

@Injectable()
export class SystemModeService implements OnModuleInit {
  private readonly logger = new Logger(SystemModeService.name);
  private cachedState: SystemState | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(DB_POOL) private readonly db: Pool,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Load state from Redis, fall back to DB, then default
    const cached = await this.redis.get(SYSTEM_STATE_KEY);
    if (cached) {
      try {
        this.cachedState = JSON.parse(cached);
        this.logger.log(`System mode loaded: ${this.cachedState?.mode}`);
        return;
      } catch { /* fall through to DB */ }
    }

    try {
      const res = await this.db.query<any>(
        `SELECT mode, reason, changed_at, changed_by, global_ads_enabled, global_organic_enabled, maintenance_message
         FROM system_state ORDER BY changed_at DESC LIMIT 1`,
      );
      if (res.rows[0]) {
        this.cachedState = this.mapRow(res.rows[0]);
        await this.redis.set(SYSTEM_STATE_KEY, JSON.stringify(this.cachedState));
        return;
      }
    } catch { /* DB not ready yet */ }

    // Default state
    this.cachedState = this.defaultState();
    this.logger.log('SystemModeService initialized with default state');
  }

  // ── Mode transitions ──────────────────────────────────────────────────────

  async setMode(mode: SystemMode, reason: string, actorId = 'system'): Promise<void> {
    const prev = this.cachedState?.mode ?? 'normal';
    const state: SystemState = {
      ...(this.cachedState ?? this.defaultState()),
      mode,
      reason,
      changedAt: new Date(),
      changedBy: actorId,
    };

    this.cachedState = state;
    await this.redis.set(SYSTEM_STATE_KEY, JSON.stringify(state));

    try {
      await this.db.query(
        `INSERT INTO system_state
           (mode, reason, changed_by, global_ads_enabled, global_organic_enabled, maintenance_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [mode, reason, actorId, state.globalAdsEnabled, state.globalOrganicEnabled, state.maintenanceMessage ?? null],
      );
    } catch (err) {
      this.logger.error(`Failed to persist system mode: ${(err as Error).message}`);
    }

    this.logger.warn(`System mode: ${prev} → ${mode} (${reason}) by ${actorId}`);
  }

  // ── Admin controls ────────────────────────────────────────────────────────

  async pauseGlobalAds(adminId: string, reason: string): Promise<void> {
    await this.updateState({ globalAdsEnabled: false }, adminId, `Ads paused: ${reason}`);
  }

  async resumeGlobalAds(adminId: string): Promise<void> {
    await this.updateState({ globalAdsEnabled: true }, adminId, 'Ads resumed');
  }

  async pauseGlobalOrganic(adminId: string, reason: string): Promise<void> {
    await this.updateState({ globalOrganicEnabled: false }, adminId, `Organic paused: ${reason}`);
  }

  async resumeGlobalOrganic(adminId: string): Promise<void> {
    await this.updateState({ globalOrganicEnabled: true }, adminId, 'Organic resumed');
  }

  async enableMaintenance(adminId: string, message: string): Promise<void> {
    await this.updateState(
      { maintenanceMessage: message },
      adminId,
      `Maintenance mode: ${message}`,
    );
    await this.setMode('maintenance', message, adminId);
  }

  async disableMaintenance(adminId: string): Promise<void> {
    await this.updateState({ maintenanceMessage: undefined }, adminId, 'Maintenance ended');
    await this.setMode('normal', 'Maintenance ended', adminId);
  }

  async freezeUser(adminId: string, userId: string, reason: string): Promise<void> {
    await this.db.query(
      'UPDATE users SET frozen = true, frozen_reason = $1, frozen_at = NOW() WHERE id = $2',
      [reason, userId],
    );
    this.logger.warn(`User ${userId} frozen by admin ${adminId}: ${reason}`);
  }

  async unfreezeUser(adminId: string, userId: string): Promise<void> {
    await this.db.query(
      'UPDATE users SET frozen = false, frozen_reason = NULL, frozen_at = NULL WHERE id = $1',
      [userId],
    );
    this.logger.log(`User ${userId} unfrozen by admin ${adminId}`);
  }

  async freezeSupplier(adminId: string, supplierId: string, reason: string): Promise<void> {
    await this.db.query(
      'UPDATE suppliers SET frozen = true, frozen_reason = $1 WHERE id = $2',
      [reason, supplierId],
    );
    this.logger.warn(`Supplier ${supplierId} frozen by admin ${adminId}: ${reason}`);
  }

  // ── State reads ───────────────────────────────────────────────────────────

  getState(): SystemState {
    return this.cachedState ?? this.defaultState();
  }

  getMode(): SystemMode {
    return this.cachedState?.mode ?? 'normal';
  }

  isAdsEnabled(): boolean {
    const s = this.getState();
    return s.mode === 'normal' && s.globalAdsEnabled;
  }

  isOrganicEnabled(): boolean {
    const s = this.getState();
    return (s.mode === 'normal' || s.mode === 'degraded') && s.globalOrganicEnabled;
  }

  isExecutionAllowed(): boolean {
    const mode = this.getMode();
    return mode === 'normal' || mode === 'degraded';
  }

  isMaintenanceMode(): boolean {
    return this.getMode() === 'maintenance';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async updateState(
    partial: Partial<SystemState>,
    actorId: string,
    reason: string,
  ): Promise<void> {
    const state: SystemState = {
      ...(this.cachedState ?? this.defaultState()),
      ...partial,
      changedAt: new Date(),
      changedBy: actorId,
      reason,
    };
    this.cachedState = state;
    await this.redis.set(SYSTEM_STATE_KEY, JSON.stringify(state));
  }

  private defaultState(): SystemState {
    return {
      mode: 'normal',
      reason: 'System initialized',
      changedAt: new Date(),
      changedBy: 'system',
      globalAdsEnabled: true,
      globalOrganicEnabled: true,
    };
  }

  private mapRow(row: any): SystemState {
    return {
      mode: row.mode,
      reason: row.reason,
      changedAt: new Date(row.changed_at),
      changedBy: row.changed_by,
      globalAdsEnabled: row.global_ads_enabled,
      globalOrganicEnabled: row.global_organic_enabled,
      maintenanceMessage: row.maintenance_message,
    };
  }

// ── V60 Controller aliases ─────────────────────────────────────────────────
  async setMaintenance(adminId: string, message = 'Maintenance in progress') {
    return this.enableMaintenance(adminId, message);
  }
  async setNormal(adminId: string) {
    return this.disableMaintenance(adminId);
  }
  getCurrentMode(): string {
    return this.cachedState?.mode ?? 'NORMAL';
  }
}
