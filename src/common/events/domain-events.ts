/**
 * domain-events.ts — CANONICAL DOMAIN EVENT DEFINITIONS
 *
 * SINGLE SOURCE OF TRUTH for all domain events in the platform.
 *
 * Rules:
 *  1. Every event MUST be defined here before use.
 *  2. Every event MUST carry tenantId and occurredAt.
 *  3. Events are immutable once emitted.
 *  4. Event names follow: DOMAIN_ACTION (PAST TENSE).
 *
 * Event categories:
 *  - Payment:    ORDER_PAID, PAYMENT_CAPTURED, PAYMENT_FAILED, REFUND_PROCESSED
 *  - Escrow:     ESCROW_CREATED, ESCROW_STATUS_CHANGED, SUPPLIER_PAID, PROFIT_DISTRIBUTED
 *  - Order:      ORDER_CREATED, ORDER_SHIPPED, TRACKING_RECEIVED, ORDER_DELIVERED
 *  - Supplier:   SUPPLIER_TASK_CREATED, SUPPLIER_TASK_COMPLETED, SUPPLIER_TASK_FAILED
 *  - AI:         AI_GENERATION_COMPLETED, AI_PROVIDER_FAILED, AI_PROVIDER_RECOVERED
 *  - Campaign:   CAMPAIGN_LAUNCHED, CAMPAIGN_PAUSED, CAMPAIGN_FAILED
 *  - Subscription: SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_CANCELLED, SUBSCRIPTION_RENEWED
 */

export const DomainEventType = {
  // ── Payment Events ─────────────────────────────────────────────────────────
  ORDER_PAID:                'ORDER_PAID',
  PAYMENT_CAPTURED:          'PAYMENT_CAPTURED',
  PAYMENT_FAILED:            'PAYMENT_FAILED',
  REFUND_PROCESSED:          'REFUND_PROCESSED',

  // ── Escrow Events ──────────────────────────────────────────────────────────
  ESCROW_CREATED:            'ESCROW_CREATED',
  ESCROW_STATUS_CHANGED:     'ESCROW_STATUS_CHANGED',
  SUPPLIER_PAID:             'SUPPLIER_PAID',
  PROFIT_DISTRIBUTED:        'PROFIT_DISTRIBUTED',

  // ── Order Events ───────────────────────────────────────────────────────────
  ORDER_CREATED:             'ORDER_CREATED',
  ORDER_SHIPPED:             'ORDER_SHIPPED',
  TRACKING_RECEIVED:         'TRACKING_RECEIVED',
  ORDER_DELIVERED:           'ORDER_DELIVERED',
  ORDER_FAILED:              'ORDER_FAILED',

  // ── Shopify Lifecycle Events (REQUIREMENT 5) ────────────────────────────────
  SHOPIFY_ORDER_CREATED:              'SHOPIFY_ORDER_CREATED',
  SHOPIFY_ORDER_PENDING:              'SHOPIFY_ORDER_PENDING',
  SHOPIFY_ORDER_PAID:                 'SHOPIFY_ORDER_PAID',
  SHOPIFY_ORDER_PROCESSING:           'SHOPIFY_ORDER_PROCESSING',
  SHOPIFY_ORDER_FULFILLING:           'SHOPIFY_ORDER_FULFILLING',
  SHOPIFY_ORDER_SHIPPED:              'SHOPIFY_ORDER_SHIPPED',
  SHOPIFY_ORDER_DELIVERED:            'SHOPIFY_ORDER_DELIVERED',
  SHOPIFY_ORDER_CANCELLED:            'SHOPIFY_ORDER_CANCELLED',
  SHOPIFY_ORDER_REFUNDED:             'SHOPIFY_ORDER_REFUNDED',
  SHOPIFY_ORDER_PARTIALLY_REFUNDED:   'SHOPIFY_ORDER_PARTIALLY_REFUNDED',

  // ── Return Lifecycle Events (REQUIREMENT 6) ─────────────────────────────────
  RETURN_REQUESTED:          'RETURN_REQUESTED',
  RETURN_APPROVED:           'RETURN_APPROVED',
  RETURN_REJECTED:           'RETURN_REJECTED',
  RETURN_PICKUP_SCHEDULED:   'RETURN_PICKUP_SCHEDULED',
  RETURN_IN_TRANSIT:         'RETURN_IN_TRANSIT',
  RETURN_RECEIVED:           'RETURN_RECEIVED',
  REFUND_PENDING:            'REFUND_PENDING',
  REFUND_COMPLETED:          'REFUND_COMPLETED',

  // ── Supplier Events ────────────────────────────────────────────────────────
  SUPPLIER_TASK_CREATED:     'SUPPLIER_TASK_CREATED',
  SUPPLIER_TASK_COMPLETED:   'SUPPLIER_TASK_COMPLETED',
  SUPPLIER_TASK_FAILED:      'SUPPLIER_TASK_FAILED',

  // ── AI Provider Events ─────────────────────────────────────────────────────
  AI_GENERATION_COMPLETED:   'AI_GENERATION_COMPLETED',
  AI_PROVIDER_FAILED:        'AI_PROVIDER_FAILED',
  AI_PROVIDER_RECOVERED:     'AI_PROVIDER_RECOVERED',

  // ── Campaign Events ────────────────────────────────────────────────────────
  CAMPAIGN_LAUNCHED:         'CAMPAIGN_LAUNCHED',
  CAMPAIGN_PAUSED:           'CAMPAIGN_PAUSED',
  CAMPAIGN_RESUMED:          'CAMPAIGN_RESUMED',
  CAMPAIGN_FAILED:           'CAMPAIGN_FAILED',

  // ── Subscription Events ────────────────────────────────────────────────────
  SUBSCRIPTION_ACTIVATED:    'SUBSCRIPTION_ACTIVATED',
  SUBSCRIPTION_CANCELLED:    'SUBSCRIPTION_CANCELLED',
  SUBSCRIPTION_RENEWED:      'SUBSCRIPTION_RENEWED',
} as const;

export type DomainEventType = typeof DomainEventType[keyof typeof DomainEventType];

// ── Base event shape ──────────────────────────────────────────────────────────

export interface DomainEvent<T = Record<string, unknown>> {
  /** Unique event ID (UUID v4) — used for idempotency */
  eventId:    string;
  /** Event type from DomainEventType enum */
  eventType:  DomainEventType;
  /** Tenant this event belongs to */
  tenantId:   string;
  /** When the event occurred (ISO 8601) */
  occurredAt: string;
  /** Event-specific payload */
  payload:    T;
  /** Optional correlation to a request or trace */
  traceId?:   string;
}

// ── Typed payloads ────────────────────────────────────────────────────────────

export interface OrderPaidPayload {
  orderId:            string;
  razorpayPaymentId:  string;
  razorpayOrderId:    string;
  customerPaidAmount: number;
  currency:           string;
  shopifyOrderId?:    string;
}

export interface EscrowCreatedPayload {
  escrowId:           string;
  orderId:            string;
  razorpayPaymentId:  string;
  customerPaidAmount: number;
  userProfit:         number;
  currency:           string;
}

export interface EscrowStatusChangedPayload {
  escrowId:   string;
  orderId:    string;
  fromStatus: string;
  toStatus:   string;
  changedBy:  string;
}

export interface SupplierPaidPayload {
  escrowId:    string;
  orderId:     string;
  amountPaid:  number;
  currency:    string;
  supplierRef: string;
}

export interface ProfitDistributedPayload {
  escrowId:   string;
  orderId:    string;
  userProfit: number;
  currency:   string;
}

export interface SupplierTaskCreatedPayload {
  taskId:   string;
  escrowId: string;
  orderId:  string;
}

export interface TrackingReceivedPayload {
  escrowId:        string;
  orderId:         string;
  trackingNumber:  string;
  carrier:         string;
  trackingUrl?:    string;
}

export interface CampaignLaunchedPayload {
  campaignId:  string;
  adAccountId: string;
  budget:      number;
  currency:    string;
  channel:     string;
}

export interface AiProviderFailedPayload {
  provider:     string;
  errorCode:    string;
  errorMessage: string;
  circuitOpen:  boolean;
}

// ── Factory helpers ───────────────────────────────────────────────────────────

import { v4 as uuidv4 } from 'uuid';

export function createDomainEvent<T>(
  eventType: DomainEventType,
  tenantId:  string,
  payload:   T,
  traceId?:  string,
): DomainEvent<T> {
  return {
    eventId:    uuidv4(),
    eventType,
    tenantId,
    occurredAt: new Date().toISOString(),
    payload,
    traceId,
  };
}
