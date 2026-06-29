/**
 * WithdrawalModule
 *
 * Provides the complete manual withdrawal system:
 *   BankEncryptionService  — AES-256-GCM encryption for bank details
 *   WithdrawalFraudService — Pre-request fraud and safety checks
 *   WithdrawalService      — Core lifecycle management
 *
 * Controllers:
 *   WithdrawalController      — User routes (request, history)
 *   AdminWithdrawalController — Admin routes (approve, reject, complete, freeze)
 *
 * Dependencies (all @Global in V59):
 *   DatabaseModule  — Drizzle ORM + DB_TOKEN
 *   AuditModule     — Immutable audit trail
 *   AlertingModule  — Telegram + email notifications
 *
 * Security notes:
 *   - BANK_ENCRYPTION_KEY must be set in env (64 hex chars = 256 bits)
 *   - BankEncryptionService validates key length on startup (OnModuleInit)
 *   - All controllers require JwtAuthGuard + RolesGuard
 */

import { Module } from '@nestjs/common';
import { WithdrawalService }        from './withdrawal.service';
import { WithdrawalFraudService }   from './withdrawal-fraud.service';
import { BankEncryptionService }    from './bank-encryption.service';
import { WithdrawalController }     from './withdrawal.controller';
import { AdminWithdrawalController } from './withdrawal.controller';
import { DatabaseModule }           from '../common/database/database.module';
import { AuditModule }              from '../audit/audit.module';

@Module({
  imports: [
    DatabaseModule, // provides DB_TOKEN (Drizzle ORM)
    AuditModule,    // provides AuditService
    // AlertingModule — @Global, no import needed
  ],
  controllers: [
    WithdrawalController,
    AdminWithdrawalController,
  ],
  providers: [
    BankEncryptionService,
    WithdrawalFraudService,
    WithdrawalService,
  ],
  exports: [
    WithdrawalService,
    WithdrawalFraudService,
    BankEncryptionService,
  ],
})
export class WithdrawalModule {}
