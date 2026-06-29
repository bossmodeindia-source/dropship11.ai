/**
 * ObservabilityModule — V65 UPDATED
 *
 * V65 additions:
 *   + QueueDepthAlerterService — monitors all BullMQ queue depths every 2 minutes,
 *     fires WARN/CRITICAL alerts when thresholds are breached, prevents alert storms
 *     via 15-minute cooldown windows.
 *   + QueueModule imported to inject queue references for depth monitoring.
 *
 * V59 original:
 *   ObservabilityService    — Prometheus gauge/counter/histogram recording
 *   ObservabilityInterceptor — HTTP request metrics (duration, status)
 *
 * @Global — ObservabilityService and QueueDepthAlerterService injected everywhere.
 */
import { Module, Global }             from '@nestjs/common';
import { ObservabilityService }       from './observability.service';
import { ObservabilityInterceptor }   from './observability.interceptor';
import { QueueDepthAlerterService }   from './queue-depth-alerter.service';
import { QueueModule }                from '../queue/queue.module';

@Global()
@Module({
  imports:   [QueueModule],
  providers: [ObservabilityService, ObservabilityInterceptor, QueueDepthAlerterService],
  exports:   [ObservabilityService, ObservabilityInterceptor, QueueDepthAlerterService],
})
export class ObservabilityModule {}
