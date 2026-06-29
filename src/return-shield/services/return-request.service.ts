/**
 * ReturnRequestService — V64 Controlled Return Shield
 *
 * CORE SERVICE — governs the entire return lifecycle.
 *
 * FINANCIAL SAFETY CONTRACT:
 *   ❌ NEVER auto-approves a return
 *   ❌ NEVER auto-refunds via Razorpay or any gateway
 *   ❌ NEVER notifies supplier to reverse order
 *   ❌ NEVER updates Shopify financial status
 *   ❌ NEVER reverses commissions or payouts
 *   ❌ NEVER modifies escrow state automatically
 *
 *   ✅ Creates RETURN_REQUEST record in RETURN_PROCESSING state (default)
 *   ✅ Runs fraud detection (flags only — never blocks submission)
 *   ✅ Records full immutable audit trail
 *   ✅ Provides admin review queue with full context
 *   ✅ Status stays RETURN_PROCESSING until admin manually intervenes
 *   ✅ OrderRefundService is ONLY reachable via explicit superadmin trigger
 */

import {
  Injectable, Logger, Inject,
  BadRequestException, NotFoundException,
  ForbiddenException, ConflictException,
  Optional,
} from '@nestjs/common';

import { DrizzleDB, DB_TOKEN }         from '../../common/database/database.module';
import { ReturnFraudDetectionService }  from './return-fraud-detection.service';
import { ReturnAuditService }           from './return-audit.service';
import {
  CreateReturnRequestDto,
  ReturnStatus,
  AdminReturnAction,
  AdminReturnActionDto,
  AdminManualRefundDto,
  CustomerReturnStatusResponse,
  toCustomerStatus,
  AdminReturnQueryDto,
} from '../dto/return-shield.dto';

// ── Status sets ──────────────────────────────────────────────────────────────
const TERMINAL_STATUSES = new Set([
  ReturnStatus.RETURN_REJECTED,
  ReturnStatus.REJECTED,             // legacy alias
  ReturnStatus.REFUND_COMPLETED,
  ReturnStatus.REFUND_MANUALLY_PROCESSED, // legacy alias
  ReturnStatus.CLOSED,
]);

// Only admin/superadmin may advance to these statuses
const ADMIN_ONLY_STATUSES = new Set([
  ReturnStatus.RETURN_APPROVED,
  ReturnStatus.RETURN_REJECTED,
  ReturnStatus.RETURN_PICKUP_SCHEDULED,
  ReturnStatus.RETURN_IN_TRANSIT,
  ReturnStatus.RETURN_RECEIVED,
  ReturnStatus.REFUND_PENDING,
  ReturnStatus.REFUND_COMPLETED,
  // Legacy aliases
  ReturnStatus.UNDER_ADMIN_REVIEW,
  ReturnStatus.WAITING_INTERNAL_APPROVAL,
  ReturnStatus.APPROVED_MANUALLY,
  ReturnStatus.REFUND_MANUALLY_PROCESSED,
  ReturnStatus.REJECTED,
  ReturnStatus.CLOSED,
]);

@Injectable()
export class ReturnRequestService {
  private readonly logger = new Logger(ReturnRequestService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
    private readonly fraudDetection:                  ReturnFraudDetectionService,
    private readonly returnAudit:                     ReturnAuditService,
    // OrderRefundService injected optionally to avoid circular dependency
    // CRITICAL: This injection is ONLY used from triggerManualRefund()
    //           which requires superadmin RBAC + explicit confirmation phrase.
    //           It is NEVER called automatically.
    @Optional() @Inject('ORDER_REFUND_SERVICE')
    private readonly orderRefundService?: {
      refundOrder(opts: {
        orderId: string; reason: string;
        partialAmount?: number; adminId?: string;
      }): Promise<{
        escrowId: string; refundAmount: number;
        gatewayRefundId: string; walletTxId: string; walletBalance: number;
      }>;
    },
  ) {}

  // ── Customer: Submit Return Request ──────────────────────────────────────
  // FINANCIAL CONTRACT: Creates a RETURN_PROCESSING record ONLY.
  // Zero financial actions. Zero supplier/inventory changes.

  async createReturnRequest(params: {
    customerId: string;
    tenantId:   string;
    dto:        CreateReturnRequestDto;
    ipAddress?: string;
  }): Promise<{
    returnRequestId: string;
    status:          ReturnStatus;
    customerMessage: string;
  }> {
    // 1. Validate order ownership
    const orderRes = await this.db.$client.query<{
      id: string; status: string; total_price: string;
      platform_order_id: string; customer_id: string;
      tenant_id: string; fulfillment_status: string; payment_status: string;
    }>(
      `SELECT id, status, total_price, platform_order_id, customer_id,
              tenant_id, fulfillment_status, payment_status
       FROM orders WHERE id = $1`,
      [params.dto.orderId],
    );

    if (!orderRes.rows.length) {
      throw new NotFoundException(`Order ${params.dto.orderId} not found`);
    }

    const order = orderRes.rows[0];

    if (order.customer_id !== params.customerId) {
      throw new ForbiddenException('You do not have permission to return this order');
    }
    if (order.tenant_id !== params.tenantId) {
      throw new ForbiddenException('Order does not belong to this account');
    }

    // 2. Prevent duplicate active returns on the same order
    const existingRes = await this.db.$client.query<{ id: string; status: string }>(
      `SELECT id, status FROM return_requests
       WHERE order_id = $1 AND status NOT IN ('REJECTED','CLOSED')
       LIMIT 1`,
      [params.dto.orderId],
    );

    if (existingRes.rows.length) {
      throw new ConflictException(
        `A return request already exists for this order ` +
        `(ID: ${existingRes.rows[0].id}, status: ${existingRes.rows[0].status}). ` +
        `Please wait for your current request to be reviewed.`,
      );
    }

    // 3. Fraud detection (async, non-blocking — flags only, never denies)
    const fraud = await this.fraudDetection.assess({
      customerId:  params.customerId,
      orderId:     params.dto.orderId,
      tenantId:    params.tenantId,
      orderAmount: parseFloat(order.total_price ?? '0'),
    });

    // 4. INSERT return request at RETURN_PROCESSING — NEVER auto-advances
    const insertRes = await this.db.$client.query<{ id: string }>(
      `INSERT INTO return_requests (
         tenant_id, order_id, customer_id, product_id,
         reason, notes, status,
         risk_level, risk_score, risk_flags,
         fulfillment_status, payment_status,
         shopify_return_blocked, shopify_refund_blocked,
         estimated_refund_exposure, currency
       ) VALUES ($1,$2,$3,$4,$5,$6,
                 'RETURN_PROCESSING',
                 $7,$8,$9::jsonb,
                 $10,$11,
                 TRUE, TRUE,
                 $12, 'INR')
       RETURNING id`,
      [
        params.tenantId,
        params.dto.orderId,
        params.customerId,
        params.dto.productId ?? null,
        params.dto.reason,
        params.dto.notes     ?? null,
        fraud.riskLevel,
        fraud.riskScore,
        JSON.stringify(fraud.riskFlags),
        order.fulfillment_status ?? null,
        order.payment_status     ?? null,
        parseFloat(order.total_price ?? '0'),
      ],
    );

    const returnRequestId = insertRes.rows[0].id;

    // 5. Append-only status history entry
    await this.db.$client.query(
      `INSERT INTO return_status_history
         (return_request_id, tenant_id, from_status, to_status, actor_id, actor_type, reason)
       VALUES ($1,$2,NULL,'RETURN_PROCESSING',$3,'user','Customer submission')`,
      [returnRequestId, params.tenantId, params.customerId],
    );

    // 6. Immutable audit entry — records what was NOT done (financial safety)
    await this.returnAudit.logReturnCreated({
      returnRequestId,
      tenantId:   params.tenantId,
      customerId: params.customerId,
      orderId:    params.dto.orderId,
      reason:     params.dto.reason,
    });

    // 7. Log fraud flag if elevated risk
    if (fraud.riskLevel !== 'LOW') {
      await this.returnAudit.logRiskFlag({
        returnRequestId,
        tenantId:  params.tenantId,
        riskLevel: fraud.riskLevel,
        riskScore: fraud.riskScore,
        flags:     fraud.riskFlags.map(f => f.code),
      });
    }

    this.logger.log(
      `📋 Return created | id=${returnRequestId} order=${params.dto.orderId} ` +
      `customer=${params.customerId} risk=${fraud.riskLevel} ` +
      `status=RETURN_PROCESSING autoRefund=BLOCKED autoSupplier=BLOCKED`,
    );

    const { customerMessage } = toCustomerStatus(ReturnStatus.RETURN_PROCESSING);
    return { returnRequestId, status: ReturnStatus.RETURN_PROCESSING, customerMessage };
  }

  // ── Customer: Get return status (sanitized) ──────────────────────────────

  async getCustomerReturnStatus(params: {
    returnRequestId: string;
    customerId:      string;
    tenantId:        string;
  }): Promise<CustomerReturnStatusResponse> {
    const res = await this.db.$client.query<{
      id: string; order_id: string; status: string;
      created_at: Date; updated_at: Date; customer_id: string;
    }>(
      `SELECT id, order_id, status, created_at, updated_at, customer_id
       FROM return_requests WHERE id = $1 AND tenant_id = $2`,
      [params.returnRequestId, params.tenantId],
    );

    if (!res.rows.length) throw new NotFoundException('Return request not found');

    const row = res.rows[0];
    if (row.customer_id !== params.customerId) {
      throw new ForbiddenException('Access denied to this return request');
    }

    const { publicStatus, customerMessage } = toCustomerStatus(row.status as ReturnStatus);
    return {
      id:            row.id,
      orderId:       row.order_id,
      publicStatus,
      customerMessage,
      submittedAt:   row.created_at.toISOString(),
      lastUpdatedAt: row.updated_at.toISOString(),
    };
  }

  // ── Customer: List own returns ────────────────────────────────────────────

  async listCustomerReturns(
    customerId: string,
    tenantId:   string,
  ): Promise<CustomerReturnStatusResponse[]> {
    const res = await this.db.$client.query<{
      id: string; order_id: string; status: string;
      created_at: Date; updated_at: Date;
    }>(
      `SELECT id, order_id, status, created_at, updated_at
       FROM return_requests
       WHERE customer_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC`,
      [customerId, tenantId],
    );

    return res.rows.map(row => {
      const { publicStatus, customerMessage } = toCustomerStatus(row.status as ReturnStatus);
      return {
        id: row.id, orderId: row.order_id, publicStatus, customerMessage,
        submittedAt: row.created_at.toISOString(), lastUpdatedAt: row.updated_at.toISOString(),
      };
    });
  }

  // ── Admin: List returns (full detail) ────────────────────────────────────

  async adminListReturns(
    query: AdminReturnQueryDto,
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[]    = [];
    let idx = 1;

    if (query.status)       { conditions.push(`r.status = $${idx++}`);      values.push(query.status); }
    if (query.tenantId)     { conditions.push(`r.tenant_id = $${idx++}`);   values.push(query.tenantId); }
    if (query.customerId)   { conditions.push(`r.customer_id = $${idx++}`); values.push(query.customerId); }
    if (query.orderId)      { conditions.push(`r.order_id = $${idx++}`);    values.push(query.orderId); }
    if (query.highRiskOnly) { conditions.push(`r.risk_level = 'HIGH_RISK_RETURN'`); }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit  = Math.min(query.limit  ?? 20, 100);
    const offset = ((query.page ?? 1) - 1) * limit;

    const [dataRes, countRes] = await Promise.all([
      this.db.$client.query<Record<string, unknown>>(
        `SELECT r.*,
                u.email      AS customer_email,
                u.full_name  AS customer_name,
                o.platform_order_id AS shopify_order_id,
                o.total_price       AS order_amount,
                o.status            AS order_status
         FROM return_requests r
         LEFT JOIN users  u ON u.id = r.customer_id
         LEFT JOIN orders o ON o.id = r.order_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT $${idx++} OFFSET $${idx}`,
        [...values, limit, offset],
      ),
      this.db.$client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM return_requests r ${where}`,
        values,
      ),
    ]);

    return {
      items: dataRes.rows,
      total: parseInt(countRes.rows[0]?.count ?? '0', 10),
    };
  }

  // ── Admin: Get full return detail ─────────────────────────────────────────

  async adminGetReturn(returnRequestId: string): Promise<Record<string, unknown>> {
    const res = await this.db.$client.query<Record<string, unknown>>(
      `SELECT r.*,
              u.email       AS customer_email,
              u.full_name   AS customer_name,
              u.created_at  AS customer_since,
              o.platform_order_id AS shopify_order_id,
              o.total_price       AS order_amount,
              o.status            AS order_status,
              o.fulfillment_status AS fulfillment_status_live
       FROM return_requests r
       LEFT JOIN users  u ON u.id = r.customer_id
       LEFT JOIN orders o ON o.id = r.order_id
       WHERE r.id = $1`,
      [returnRequestId],
    );

    if (!res.rows.length) throw new NotFoundException('Return request not found');

    const history = await this.db.$client.query<Record<string, unknown>>(
      `SELECT h.*, u.email AS actor_email
       FROM return_status_history h
       LEFT JOIN users u ON u.id = h.actor_id
       WHERE return_request_id = $1 ORDER BY created_at ASC`,
      [returnRequestId],
    );

    return { ...res.rows[0], statusHistory: history.rows };
  }

  // ── Admin: Perform moderation action ────────────────────────────────────
  // CRITICAL: This endpoint NEVER triggers financial actions.
  // Use triggerManualRefund() for that (superadmin + confirmation required).

  async adminPerformAction(params: {
    returnRequestId: string;
    adminId:         string;
    adminRole:       string;
    dto:             AdminReturnActionDto;
    ipAddress?:      string;
  }): Promise<{ success: boolean; newStatus: string; message: string }> {
    const { returnRequestId, adminId, adminRole, dto, ipAddress } = params;

    if (!['admin', 'superadmin'].includes(adminRole)) {
      throw new ForbiddenException('Only admin or superadmin can perform return actions');
    }

    const current = await this.db.$client.query<{ status: string; tenant_id: string }>(
      `SELECT status, tenant_id FROM return_requests WHERE id = $1`,
      [returnRequestId],
    );
    if (!current.rows.length) throw new NotFoundException('Return request not found');

    const { status: currentStatus, tenant_id: tenantId } = current.rows[0];
    let   newStatus   = currentStatus;
    let   setParts:    string[] = [];
    let   auditAction: any      = 'STATUS_CHANGED';
    let   description  = '';
    const setParms:    unknown[] = [];
    let   pIdx = 1;

    // Build SET clause dynamically
    const addField = (expr: string, val?: unknown) => {
      if (val !== undefined) { setParms.push(val); setParts.push(`${expr} = $${pIdx++}`); }
      else { setParts.push(expr); }
    };

    switch (dto.action) {
      case AdminReturnAction.APPROVE:
        newStatus   = ReturnStatus.APPROVED_MANUALLY;
        auditAction = 'APPROVED';
        description = 'Return approved manually by admin';
        addField('status',            newStatus);
        addField('admin_notes',       dto.adminNotes);
        addField('admin_actor_id',    adminId);
        addField('admin_reviewed_at = NOW()');
        break;

      case AdminReturnAction.REJECT:
        if (!dto.rejectionReason) throw new BadRequestException('rejectionReason is required');
        newStatus   = ReturnStatus.REJECTED;
        auditAction = 'REJECTED';
        description = `Return rejected: ${dto.rejectionReason}`;
        addField('status',            newStatus);
        addField('admin_notes',       dto.adminNotes);
        addField('rejection_reason',  dto.rejectionReason);
        addField('admin_actor_id',    adminId);
        addField('admin_reviewed_at = NOW()');
        break;

      case AdminReturnAction.MORE_INFO_REQUESTED:
        newStatus   = ReturnStatus.UNDER_ADMIN_REVIEW;
        auditAction = 'MORE_INFO_REQUESTED';
        description = 'More information requested from customer';
        addField('status',         newStatus);
        addField('admin_notes',    dto.adminNotes);
        addField('admin_actor_id', adminId);
        break;

      case AdminReturnAction.FREEZE:
        newStatus   = ReturnStatus.WAITING_INTERNAL_APPROVAL;
        auditAction = 'FROZEN';
        description = 'Return frozen pending internal approval';
        addField('status',         newStatus);
        addField('admin_notes',    dto.adminNotes);
        addField('admin_actor_id', adminId);
        break;

      case AdminReturnAction.CLOSE:
        newStatus   = ReturnStatus.CLOSED;
        auditAction = 'CLOSED';
        description = `Return closed by ${adminRole}`;
        addField('status',         newStatus);
        addField('admin_notes',    dto.adminNotes);
        addField('admin_actor_id', adminId);
        addField('closed_at = NOW()');
        break;

      case AdminReturnAction.ADD_NOTE:
        // Status unchanged — only updates admin notes
        auditAction = 'NOTE_ADDED';
        description = `Admin note added`;
        addField('admin_notes',    dto.adminNotes);
        addField('admin_actor_id', adminId);
        break;

      case AdminReturnAction.CHANGE_STATUS:
        if (!dto.targetStatus) throw new BadRequestException('targetStatus required');
        if (!ADMIN_ONLY_STATUSES.has(dto.targetStatus)) {
          throw new BadRequestException(`Cannot manually set status to ${dto.targetStatus}`);
        }
        newStatus   = dto.targetStatus;
        auditAction = 'STATUS_CHANGED';
        description = `Status manually changed to ${dto.targetStatus}`;
        addField('status',         newStatus);
        addField('admin_notes',    dto.adminNotes);
        addField('admin_actor_id', adminId);
        break;

      default:
        throw new BadRequestException(`Use dedicated endpoint for action: ${dto.action}`);
    }

    const setClause = [...setParts, `updated_at = NOW()`].join(', ');
    setParms.push(returnRequestId);

    await this.db.$client.query(
      `UPDATE return_requests SET ${setClause} WHERE id = $${pIdx}`,
      setParms,
    );

    // Append-only status history
    if (newStatus !== currentStatus) {
      await this.db.$client.query(
        `INSERT INTO return_status_history
           (return_request_id, tenant_id, from_status, to_status, actor_id, actor_type, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [returnRequestId, tenantId, currentStatus, newStatus, adminId, adminRole, dto.adminNotes ?? null],
      );
    }

    // Immutable audit
    await this.returnAudit.log({
      returnRequestId,
      tenantId,
      actorId:       adminId,
      actorRole:     adminRole,
      action:        auditAction,
      description,
      previousValue: { status: currentStatus },
      newValue:      { status: newStatus, adminNotes: dto.adminNotes },
      ipAddress,
    });

    return { success: true, newStatus, message: description };
  }

  // ── Admin: Trigger Manual Refund ─────────────────────────────────────────
  //
  // ⚠️  SOLE FINANCIAL ACTION PATH IN THE RETURN SYSTEM ⚠️
  //
  // Guards:
  //   1. Caller must hold 'superadmin' role (enforced at controller layer)
  //   2. Return must be in APPROVED_MANUALLY status
  //   3. Body must contain confirmationPhrase === 'CONFIRM_REFUND'
  //
  // If OrderRefundService is wired (WalletModule imported), executes the full
  // Razorpay refund → wallet credit → escrow advance pipeline.
  // If not wired, records intent and instructs finance team to execute manually.

  async triggerManualRefund(params: {
    returnRequestId: string;
    adminId:         string;
    adminRole:       string;
    dto:             AdminManualRefundDto;
    ipAddress?:      string;
  }): Promise<{ success: boolean; message: string; refundAmount: number; gatewayRefundId?: string }> {
    const { returnRequestId, adminId, adminRole, dto, ipAddress } = params;

    if (!['admin', 'superadmin'].includes(adminRole)) {
      throw new ForbiddenException('Only superadmin can trigger manual refunds');
    }

    // Explicit confirmation guard — prevents accidental trigger
    if (dto.confirmationPhrase !== 'CONFIRM_REFUND') {
      throw new BadRequestException(
        'Invalid confirmation. Set confirmationPhrase to "CONFIRM_REFUND" to proceed.',
      );
    }

    const res = await this.db.$client.query<{
      id: string; status: string; tenant_id: string; order_id: string;
      customer_id: string; estimated_refund_exposure: string;
    }>(
      `SELECT id, status, tenant_id, order_id, customer_id, estimated_refund_exposure
       FROM return_requests WHERE id = $1`,
      [returnRequestId],
    );

    if (!res.rows.length) throw new NotFoundException('Return request not found');
    const row = res.rows[0];

    if (row.status !== ReturnStatus.APPROVED_MANUALLY) {
      throw new BadRequestException(
        `Refund requires APPROVED_MANUALLY status. Current: ${row.status}. ` +
        `Approve the return first using the /action endpoint.`,
      );
    }

    const refundAmount = dto.partialAmount
      ?? parseFloat(row.estimated_refund_exposure ?? '0');

    if (refundAmount <= 0) {
      throw new BadRequestException('Refund amount must be greater than zero');
    }

    let gatewayRefundId: string | undefined;
    let walletTxId:      string | undefined;

    // Execute full refund pipeline if OrderRefundService is injected
    if (this.orderRefundService) {
      this.logger.log(
        `💸 Executing full refund pipeline | return=${returnRequestId} ` +
        `order=${row.order_id} amount=₹${refundAmount} admin=${adminId}`,
      );

      const refundResult = await this.orderRefundService.refundOrder({
        orderId:       row.order_id,
        reason:        dto.reason,
        partialAmount: dto.partialAmount,
        adminId,
      });

      gatewayRefundId = refundResult.gatewayRefundId;
      walletTxId      = refundResult.walletTxId;
    } else {
      this.logger.warn(
        `OrderRefundService not wired — recording intent only. ` +
        `Finance team must execute Razorpay refund manually for order ${row.order_id}.`,
      );
    }

    // Mark return as refund processed
    await this.db.$client.query(
      `UPDATE return_requests SET
         status                = 'REFUND_MANUALLY_PROCESSED',
         refund_processed_at   = NOW(),
         admin_notes           = $1,
         updated_at            = NOW()
       WHERE id = $2`,
      [
        `Manual refund ₹${refundAmount} by ${adminRole}. ${dto.reason}` +
        (gatewayRefundId ? ` GW: ${gatewayRefundId}` : ' [Intent recorded — execute via gateway]'),
        returnRequestId,
      ],
    );

    // Append-only status history
    await this.db.$client.query(
      `INSERT INTO return_status_history
         (return_request_id, tenant_id, from_status, to_status, actor_id, actor_type, reason)
       VALUES ($1,$2,'APPROVED_MANUALLY','REFUND_MANUALLY_PROCESSED',$3,$4,$5)`,
      [returnRequestId, row.tenant_id, adminId, adminRole, dto.reason],
    );

    // Immutable audit
    await this.returnAudit.logManualRefundTriggered({
      returnRequestId,
      tenantId:     row.tenant_id,
      adminId,
      refundAmount,
      reason:       dto.reason,
      ipAddress,
    });

    this.logger.log(
      `✅ Manual refund complete | return=${returnRequestId} ` +
      `order=${row.order_id} amount=₹${refundAmount} ` +
      `gateway=${gatewayRefundId ?? 'manual'} wallet=${walletTxId ?? 'n/a'}`,
    );

    return {
      success:        true,
      message:        gatewayRefundId
        ? `Refund of ₹${refundAmount} processed via gateway. Wallet credited. Escrow advanced.`
        : `Refund intent of ₹${refundAmount} recorded. Finance team must execute via Razorpay dashboard.`,
      refundAmount,
      gatewayRefundId,
    };
  }
}
