/**
 * TraceContextPropagation — V66 Medium Fix #3
 *
 * Injects W3C TraceContext headers into BullMQ job data when enqueuing.
 * Extracts and restores the trace context inside workers.
 *
 * Result: single distributed trace spanning:
 *   API → Queue → Worker → Supplier → Tracking
 *
 * W3C Trace Context spec: https://www.w3.org/TR/trace-context/
 * Format: traceparent: 00-{traceId}-{spanId}-{flags}
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  context,
  propagation,
  trace,
  Context,
  Span,
  SpanStatusCode,
} from '@opentelemetry/api';

export interface TraceContext {
  traceparent?: string;
  tracestate?:  string;
}

@Injectable()
export class TraceContextService {
  private readonly logger = new Logger(TraceContextService.name);

  /**
   * Extract the current W3C TraceContext from the active OTEL span.
   * Call this BEFORE enqueuing a job so the context is captured.
   *
   * @returns TraceContext to embed in job.data
   */
  extract(): TraceContext {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);

    return {
      traceparent: carrier['traceparent'],
      tracestate:  carrier['tracestate'],
    };
  }

  /**
   * Restore W3C TraceContext inside a worker before processing.
   * Creates a child span linked to the original API request.
   *
   * @param traceCtx - TraceContext extracted from job.data
   * @param spanName - Name for the worker span
   * @param fn - The job processing function
   */
  async runWithContext<T>(
    traceCtx: TraceContext | undefined,
    spanName:  string,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    if (!traceCtx?.traceparent) {
      // No context propagated — run without distributed trace linkage
      const tracer = trace.getTracer('aiempire-worker');
      const span = tracer.startSpan(spanName);
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    }

    // Restore the parent context from the injected TraceContext
    const carrier: Record<string, string> = {};
    if (traceCtx.traceparent) carrier['traceparent'] = traceCtx.traceparent;
    if (traceCtx.tracestate)  carrier['tracestate']  = traceCtx.tracestate;

    const parentContext: Context = propagation.extract(context.active(), carrier);
    const tracer = trace.getTracer('aiempire-worker');

    return context.with(parentContext, async () => {
      const span = tracer.startSpan(spanName, undefined, parentContext);
      return context.with(trace.setSpan(parentContext, span), async () => {
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      });
    });
  }
}

// ── Decorator: inject trace context into job data ──────────────────────────────
/**
 * Wrap a queue.add() call to automatically inject the current trace context.
 *
 * Usage:
 *   const jobData = withTraceContext(traceService, { orderId, userId });
 *   await queue.add('process', jobData);
 */
export function withTraceContext<T extends object>(
  traceService: TraceContextService,
  data: T,
): T & { __traceContext?: TraceContext } {
  return {
    ...data,
    __traceContext: traceService.extract(),
  };
}
