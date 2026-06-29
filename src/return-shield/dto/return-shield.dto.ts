/**
 * return-shield DTOs
 *
 * Customer-facing: CreateReturnRequestDto
 * Admin-facing:    AdminReturnActionDto, AdminReturnQueryDto, AdminRefundDto
 */

import {
  IsString, IsOptional, IsUUID, IsEnum,
  IsArray, IsNumber, MinLength, MaxLength,
  Min, Max, IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Return Status ────────────────────────────────────────────────────────────
export enum ReturnStatus {
  // ── V70 required lifecycle states (REQUIREMENT 6) ─────────────────────────
  RETURN_REQUESTED          = 'RETURN_REQUESTED',
  RETURN_APPROVED           = 'RETURN_APPROVED',
  RETURN_REJECTED           = 'RETURN_REJECTED',
  RETURN_PICKUP_SCHEDULED   = 'RETURN_PICKUP_SCHEDULED',
  RETURN_IN_TRANSIT         = 'RETURN_IN_TRANSIT',
  RETURN_RECEIVED           = 'RETURN_RECEIVED',
  REFUND_PENDING            = 'REFUND_PENDING',
  REFUND_COMPLETED          = 'REFUND_COMPLETED',
  // ── Legacy states (backward compatible — maps to new states) ─────────────
  RETURN_PROCESSING         = 'RETURN_PROCESSING',
  UNDER_ADMIN_REVIEW        = 'UNDER_ADMIN_REVIEW',
  WAITING_INTERNAL_APPROVAL = 'WAITING_INTERNAL_APPROVAL',
  REJECTED                  = 'REJECTED',           // alias → RETURN_REJECTED
  APPROVED_MANUALLY         = 'APPROVED_MANUALLY',  // alias → RETURN_APPROVED
  REFUND_MANUALLY_PROCESSED = 'REFUND_MANUALLY_PROCESSED', // alias → REFUND_COMPLETED
  CLOSED                    = 'CLOSED',
}

// ── Admin Return Action Types ────────────────────────────────────────────────
export enum AdminReturnAction {
  APPROVE             = 'APPROVE',
  REJECT              = 'REJECT',
  MORE_INFO_REQUESTED = 'MORE_INFO_REQUESTED',
  FREEZE              = 'FREEZE',
  CLOSE               = 'CLOSE',
  TRIGGER_REFUND      = 'TRIGGER_REFUND',
  ADD_NOTE            = 'ADD_NOTE',
  FLAG_RISK           = 'FLAG_RISK',
  UNFLAG_RISK         = 'UNFLAG_RISK',
  CHANGE_STATUS       = 'CHANGE_STATUS',
}

// ── Return Reason Enum ───────────────────────────────────────────────────────
export enum ReturnReason {
  DAMAGED             = 'damaged',
  WRONG_ITEM          = 'wrong_item',
  NOT_AS_DESCRIBED    = 'not_as_described',
  QUALITY_ISSUE       = 'quality_issue',
  DID_NOT_ARRIVE      = 'did_not_arrive',
  CHANGED_MIND        = 'changed_mind',
  OTHER               = 'other',
}

// ── Customer: Submit Return Request ─────────────────────────────────────────
export class CreateReturnRequestDto {
  @ApiProperty({ description: 'The order ID to return' })
  @IsUUID()
  orderId: string;

  @ApiPropertyOptional({ description: 'Specific product variant ID (if multi-product order)' })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiProperty({ enum: ReturnReason, description: 'Primary return reason category' })
  @IsEnum(ReturnReason)
  reasonCategory: ReturnReason;

  @ApiProperty({ description: 'Detailed description of the return reason', minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({ description: 'Additional notes', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ── Admin: Query Returns ─────────────────────────────────────────────────────
export class AdminReturnQueryDto {
  @ApiPropertyOptional({ enum: ReturnStatus })
  @IsOptional()
  @IsEnum(ReturnStatus)
  status?: ReturnStatus;

  @ApiPropertyOptional({ description: 'Filter by tenant ID' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Filter by customer ID' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Filter by order ID' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ description: 'Filter HIGH_RISK_RETURN only', default: false })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  highRiskOnly?: boolean;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;
}

// ── Admin: Perform Return Action ─────────────────────────────────────────────
export class AdminReturnActionDto {
  @ApiProperty({ enum: AdminReturnAction })
  @IsEnum(AdminReturnAction)
  action: AdminReturnAction;

  @ApiPropertyOptional({ description: 'Admin notes or reason for action' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;

  @ApiPropertyOptional({ description: 'Rejection reason (required for REJECT action)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rejectionReason?: string;

  @ApiPropertyOptional({ enum: ReturnStatus, description: 'Target status (for CHANGE_STATUS action)' })
  @IsOptional()
  @IsEnum(ReturnStatus)
  targetStatus?: ReturnStatus;
}

// ── Admin: Manually Trigger Refund ──────────────────────────────────────────
// This DTO requires explicit admin confirmation.
// CRITICAL: This is the ONLY path to trigger a financial action.
export class AdminManualRefundDto {
  @ApiProperty({ description: 'Explicit admin confirmation phrase', example: 'CONFIRM_REFUND' })
  @IsString()
  confirmationPhrase: string;   // must equal 'CONFIRM_REFUND'

  @ApiPropertyOptional({ description: 'Partial refund amount (omit for full refund)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  partialAmount?: number;

  @ApiProperty({ description: 'Reason for manual refund approval' })
  @IsString()
  @MinLength(10)
  reason: string;
}

// ── Response: Customer Return Status ────────────────────────────────────────
// IMPORTANT: Never expose internal moderation state, admin notes, financial details
export class CustomerReturnStatusResponse {
  id: string;
  orderId: string;
  publicStatus: 'processing' | 'under_review' | 'approved' | 'rejected' | 'closed';
  customerMessage: string;
  submittedAt: string;
  lastUpdatedAt: string;
}

// Maps internal status to customer-safe display
export function toCustomerStatus(
  internalStatus: ReturnStatus,
): { publicStatus: CustomerReturnStatusResponse['publicStatus']; customerMessage: string } {
  switch (internalStatus) {
    case ReturnStatus.RETURN_REQUESTED:
    case ReturnStatus.RETURN_PROCESSING:
    case ReturnStatus.UNDER_ADMIN_REVIEW:
    case ReturnStatus.WAITING_INTERNAL_APPROVAL:
      return {
        publicStatus:    'processing',
        customerMessage: 'Your return request is currently being reviewed. Our team will reach out shortly.',
      };
    case ReturnStatus.RETURN_APPROVED:
    case ReturnStatus.APPROVED_MANUALLY:
      return {
        publicStatus:    'approved',
        customerMessage: 'Your return has been approved. Our team will arrange pickup shortly.',
      };
    case ReturnStatus.RETURN_PICKUP_SCHEDULED:
      return {
        publicStatus:    'approved',
        customerMessage: 'Pickup has been scheduled. Please have the item ready for collection.',
      };
    case ReturnStatus.RETURN_IN_TRANSIT:
      return {
        publicStatus:    'approved',
        customerMessage: 'Your return item is in transit to our warehouse.',
      };
    case ReturnStatus.RETURN_RECEIVED:
      return {
        publicStatus:    'approved',
        customerMessage: 'We have received your returned item and are inspecting it.',
      };
    case ReturnStatus.REFUND_PENDING:
      return {
        publicStatus:    'approved',
        customerMessage: 'Your refund has been authorised and is being processed. Please allow 3-7 business days.',
      };
    case ReturnStatus.REFUND_COMPLETED:
    case ReturnStatus.REFUND_MANUALLY_PROCESSED:
      return {
        publicStatus:    'approved',
        customerMessage: 'Your refund has been successfully issued. Please allow 3-7 business days to appear.',
      };
    case ReturnStatus.RETURN_REJECTED:
    case ReturnStatus.REJECTED:
      return {
        publicStatus:    'rejected',
        customerMessage: 'Your return request could not be approved at this time. Please contact support.',
      };
    case ReturnStatus.CLOSED:
      return {
        publicStatus:    'closed',
        customerMessage: 'This return request has been closed.',
      };
    default:
      return {
        publicStatus:    'processing',
        customerMessage: 'Your return request is being reviewed.',
      };
  }
}
