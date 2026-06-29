import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { AuthModule }      from '../auth/auth.module';

/**
 * RealtimeModule — V59 Tenant-Isolated WebSocket Gateway
 *
 * Single WS source of truth — replaces all legacy socket emit points.
 *
 * Depends on:
 *   AuthModule — JwtService for handshake token verification.
 *
 * RealtimeGateway is exported so other services (CommercePipeline,
 * OrderSync, AlertingService) can inject it and call emitToTenant()
 * for live updates without coupling to socket.io internals.
 *
 * Socket.IO server is bound to the same HTTP port (NestJS adapter).
 * Tenant rooms: `tenant:{tenantId}` — each WS client joins only their room.
 * Admin room:   `admin`            — super_admin clients only.
 */
@Module({
  imports:   [AuthModule],
  providers: [RealtimeGateway],
  exports:   [RealtimeGateway],
})
export class RealtimeModule {}
