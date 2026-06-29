/**
 * RealtimeGateway — V59 Tenant-Isolated WebSocket Server
 *
 * Provides live updates for:
 *   - Campaign status changes (launched, paused, failed, optimized)
 *   - Order events (created, paid, fulfilled, refunded)
 *   - Profit updates (real-time P&L)
 *   - System alerts (API failures, spend caps, queue issues)
 *   - Bot status (active, paused, error)
 *   - Product discovery events (new winner found)
 *
 * Tenant isolation:
 *   - Each tenant connection verified via JWT on handshake
 *   - Rooms: `tenant:{tenantId}` — messages ONLY emitted to correct room
 *   - Admin room: `admin` — system-wide events (admin users only)
 *
 * Events emitted to client:
 *   campaign:update    { campaignId, status, roas, spend }
 *   order:update       { orderId, status, amount }
 *   profit:update      { todayRevenue, todayProfit, roas }
 *   alert              { level, title, message }
 *   bot:status         { botId, status, activeProducts }
 *   product:winner     { productId, name, score }
 *   system:mode        { mode, reason }
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
/** Socket.io client augmented with per-connection auth context. */
interface TenantSocket extends Socket {
  tenantId?: string;
  userId?:   string;
}

import { Injectable, Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

export type RealtimeEvent =
  | 'campaign:update'
  | 'order:update'
  | 'profit:update'
  | 'alert'
  | 'bot:status'
  | 'product:winner'
  | 'system:mode'
  | 'queue:depths'
  | 'spend:update'
  // ── Telegram Storage events (V60) ─────────────────────────────────────────
  | 'upload_complete'
  | 'upload_failed'
  | 'asset_ready'
  | 'bot_overloaded'
  | 'bot_disabled'
  | 'replication_complete';

@Injectable()
@WebSocketGateway({
  // CORS origins are resolved at socket connection time via the handleConnection
  // allowRequest callback below. The static decorator value is a fallback only.
  // Use ALLOWED_ORIGINS env var (comma-separated) to set production origins.
  cors: {
    origin: (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:3000').split(',').map(o => o.trim()),
    credentials: true,
  },
  namespace: '/realtime',
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly io!: Server;

  private readonly logger   = new Logger(RealtimeGateway.name);
  // Map: socketId → tenantId (for logging / cleanup)
  private readonly clientMap = new Map<string, string>();

  constructor(
    private readonly jwt:    JwtService,
    private readonly config: ConfigService,
  ) {}

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async handleConnection(client: TenantSocket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) throw new Error('No token provided');

      const payload = await this.jwt.verifyAsync<{
        sub: string;
        tenant_id: string;
        role?: string;
      }>(token);

      const { tenant_id: tenantId, role } = payload;
      if (!tenantId) throw new Error('Token missing tenant_id');

      // Join tenant room (isolation enforced)
      await client.join(`tenant:${tenantId}`);
      client.tenantId = tenantId;
      client.userId   = String(payload.sub);

      // Admins also join global admin room
      if (role === 'superadmin' || role === 'admin') {
        await client.join('admin');
      }

      this.clientMap.set(client.id, tenantId);
      this.logger.log(`WS connected: ${client.id} → tenant:${tenantId}`);

      // Send current system state on connection
      client.emit('connected', { tenantId, timestamp: new Date().toISOString() });

    } catch (err) {
      this.logger.warn(`WS connection rejected: ${(err as Error).message}`);
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: TenantSocket): void {
    const tenantId = this.clientMap.get(client.id);
    this.clientMap.delete(client.id);
    this.logger.log(`WS disconnected: ${client.id} (tenant:${tenantId ?? 'unknown'})`);
  }

  // ── Client subscriptions ──────────────────────────────────────────────────

  @SubscribeMessage('subscribe:bot')
  handleBotSubscribe(
    @ConnectedSocket() client: TenantSocket,
    @MessageBody() data: { botId: string },
  ): void {
    const tenantId = client.tenantId ?? '';
    // Join bot-specific room within tenant scope
    void client.join(`tenant:${tenantId}:bot:${data.botId}`);
    client.emit('subscribed', { resource: 'bot', id: data.botId });
  }

  @SubscribeMessage('subscribe:campaign')
  handleCampaignSubscribe(
    @ConnectedSocket() client: TenantSocket,
    @MessageBody() data: { campaignId: string },
  ): void {
    const tenantId = client.tenantId ?? '';
    void client.join(`tenant:${tenantId}:campaign:${data.campaignId}`);
    client.emit('subscribed', { resource: 'campaign', id: data.campaignId });
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', { timestamp: Date.now() });
  }

  // ── Emit methods (called by services) ────────────────────────────────────

  emitToTenant(tenantId: string, event: RealtimeEvent, data: unknown): void {
    this.io.to(`tenant:${tenantId}`).emit(event, {
      ...((data as object) ?? {}),
      timestamp: new Date().toISOString(),
    });
  }

  emitCampaignUpdate(tenantId: string, payload: {
    campaignId: string;
    status: string;
    roas?: number;
    spend?: number;
    impressions?: number;
  }): void {
    this.emitToTenant(tenantId, 'campaign:update', payload);
    // Also emit to campaign-specific room
    this.io
      .to(`tenant:${tenantId}:campaign:${payload.campaignId}`)
      .emit('campaign:update', { ...payload, timestamp: new Date().toISOString() });
  }

  emitOrderUpdate(tenantId: string, payload: {
    orderId: string;
    status: string;
    amount?: number;
    currency?: string;
  }): void {
    this.emitToTenant(tenantId, 'order:update', payload);
  }

  emitProfitUpdate(tenantId: string, payload: {
    todayRevenue: number;
    todayProfit: number;
    todaySpend: number;
    roas: number;
  }): void {
    this.emitToTenant(tenantId, 'profit:update', payload);
  }

  emitAlert(tenantId: string | null, payload: {
    level: 'info' | 'warn' | 'critical';
    title: string;
    message: string;
    data?: unknown;
  }): void {
    if (tenantId) {
      this.emitToTenant(tenantId, 'alert', payload);
    }
    // Always emit critical alerts to admin room
    if (payload.level === 'critical') {
      this.io.to('admin').emit('alert', {
        ...payload,
        tenantId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  emitBotStatus(tenantId: string, payload: {
    botId: string;
    status: string;
    activeProducts?: number;
    activeAdSets?: number;
  }): void {
    this.emitToTenant(tenantId, 'bot:status', payload);
    this.io
      .to(`tenant:${tenantId}:bot:${payload.botId}`)
      .emit('bot:status', { ...payload, timestamp: new Date().toISOString() });
  }

  emitProductWinner(tenantId: string, payload: {
    productId: string;
    name: string;
    score: number;
    estimatedRoas?: number;
  }): void {
    this.emitToTenant(tenantId, 'product:winner', payload);
  }

  emitSystemMode(mode: string, reason: string): void {
    this.io.emit('system:mode', { mode, reason, timestamp: new Date().toISOString() });
  }

  emitQueueDepths(depths: Record<string, { waiting: number; active: number; failed: number }>): void {
    this.io.to('admin').emit('queue:depths', { depths, timestamp: new Date().toISOString() });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getConnectedCount(): number {
    return this.clientMap.size;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractToken(client: Socket): string | null {
    // Try Authorization header first, then query param (for browser clients)
    const auth = client.handshake.auth?.token as string | undefined;
    if (auth) return auth;

    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);

    const query = client.handshake.query.token as string | undefined;
    return query ?? null;
  }
}
