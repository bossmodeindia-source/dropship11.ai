/**
 * FinancialTraceSampler — V66 HIGH PRIORITY
 *
 * Replaces global OTEL_SAMPLING_RATIO=0.1 with a smart sampler:
 *
 *   Financial routes → 100% sampling (audit-grade)
 *   All other routes → 10% sampling
 *
 * Financial routes:
 *   /webhooks/*
 *   /api/payment/*
 *   /api/escrow/*
 *   /api/withdrawal/*
 *   /api/supplier-payment/*
 */

import {
  Sampler,
  SamplingDecision,
  SamplingResult,
  Context,
  SpanKind,
  Attributes,
  Link,
  trace,
} from '@opentelemetry/api';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

const FINANCIAL_ROUTES = [
  '/webhooks/',
  '/api/payment/',
  '/api/escrow/',
  '/api/withdrawal/',
  '/api/supplier-payment/',
];

export class FinancialTraceSampler implements Sampler {
  private readonly fullSampler: Sampler;
  private readonly partialSampler: Sampler;
  private readonly partialRatio: number;

  constructor(partialRatio = 0.1) {
    this.partialRatio   = partialRatio;
    this.fullSampler    = new TraceIdRatioBasedSampler(1.0);
    this.partialSampler = new TraceIdRatioBasedSampler(partialRatio);
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    // Extract HTTP URL from semantic attributes
    const httpTarget = (
      (attributes[SemanticAttributes.HTTP_TARGET] as string) ||
      (attributes[SemanticAttributes.HTTP_URL] as string) ||
      spanName
    );

    const isFinancial = FINANCIAL_ROUTES.some(route =>
      httpTarget?.includes(route),
    );

    if (isFinancial) {
      return {
        decision: SamplingDecision.RECORD_AND_SAMPLED,
        attributes: {
          ...attributes,
          'sampling.priority': 1,
          'financial.route': true,
        },
      };
    }

    return this.partialSampler.shouldSample(
      context, traceId, spanName, spanKind, attributes, links,
    );
  }

  toString(): string {
    return `FinancialTraceSampler{financial=100%, other=${this.partialRatio * 100}%}`;
  }
}

/**
 * Apply financial sampler to the active OTEL tracer provider.
 * Call this in the instrumentation bootstrap (main.ts or instrumentation.ts).
 */
export function createFinancialSampler(partialRatio = 0.1): FinancialTraceSampler {
  return new FinancialTraceSampler(partialRatio);
}
