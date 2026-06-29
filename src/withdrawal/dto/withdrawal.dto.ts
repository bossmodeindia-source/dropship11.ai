/**
 * Withdrawal DTOs
 *
 * All inputs validated with class-validator.
 * Bank details are accepted in plaintext on request, immediately encrypted.
 * Admin DTOs are kept minimal — amounts/decisions only, never re-expose bank data.
 */

import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  Min,
  MaxLength,
  IsOptional,
  Matches,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── User: Request Withdrawal ──────────────────────────────────────────────────

export class RequestWithdrawalDto {
  @ApiProperty({ description: 'Amount to withdraw in INR', example: 5000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Min(100, { message: 'Minimum withdrawal amount is ₹100' })
  amount!: number;

  @ApiProperty({ description: 'Bank name', example: 'HDFC Bank' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  bankName!: string;

  @ApiProperty({ description: 'Account holder full name as per bank records' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  accountHolderName!: string;

  @ApiProperty({ description: 'Bank account number (9–18 digits)', example: '1234567890' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{9,18}$/, { message: 'Account number must be 9–18 digits' })
  accountNumber!: string;

  @ApiProperty({ description: 'IFSC code (11 alphanumeric chars)', example: 'HDFC0001234' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: 'IFSC code must be in format XXXX0XXXXXX (e.g. HDFC0001234)',
  })
  ifscCode!: string;
}

// ── Admin: Approve ────────────────────────────────────────────────────────────

export class ApproveWithdrawalDto {
  @ApiPropertyOptional({ description: 'Admin notes (visible in audit log)', example: 'Verified manually' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNotes?: string;
}

// ── Admin: Reject ─────────────────────────────────────────────────────────────

export class RejectWithdrawalDto {
  @ApiProperty({ description: 'Reason for rejection — mandatory on reject' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  adminNotes!: string;
}

// ── Admin: Complete Payout ────────────────────────────────────────────────────

export class CompleteWithdrawalDto {
  @ApiPropertyOptional({ description: 'Razorpay payout ID for reference', example: 'pout_XYZ123' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  razorpayPayoutId?: string;

  @ApiPropertyOptional({ description: 'Admin notes for completion' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  adminNotes?: string;
}

// ── Admin: Freeze Account ─────────────────────────────────────────────────────

export class FreezeWithdrawalDto {
  @ApiProperty({ description: 'Reason for freezing this withdrawal request' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

// ── Response shapes ───────────────────────────────────────────────────────────

export interface WithdrawalSummary {
  id:          string;
  amount:      number;
  currency:    string;
  status:      string;
  bankName:    string;
  isFrozen:    boolean;
  adminNotes:  string | null;
  createdAt:   Date;
  processedAt: Date | null;
}

export interface AdminWithdrawalView extends WithdrawalSummary {
  tenantId:    string;
  userId:      string;
  pendingOrdersAtRequest: number;
  razorpayPayoutId: string | null;
  // Decrypted bank details — only populated when admin explicitly requests decrypt
  bankDetails?: {
    accountHolderName: string;
    accountNumber:     string;
    ifscCode:          string;
  };
}
