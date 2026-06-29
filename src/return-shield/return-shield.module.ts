/**
 * ReturnShieldModule — V64
 *
 * Controlled Customer Return Shield System — Admin-Governed Returns Flow.
 *
 * WIRES:
 *   ReturnRequestService         — core lifecycle (financial safety contract)
 *   ReturnFraudDetectionService  — abuse scoring + HIGH_RISK_RETURN flagging
 *   ReturnEvidenceStorageService — Telegram CDN evidence (admin-only refs)
 *   ReturnAuditService           — immutable append-only audit trail
 *   ReturnRequestController      — customer-facing API
 *   AdminReturnModerationController — full admin workspace
 *   ShopifyReturnInterceptController — webhook override (blocks Shopify auto-refund)
 *
 * REUSES (not duplicated):
 *   TelegramStorageModule — TelegramUploadService + TelegramBotRoutingService
 *   ShopifyModule         — ShopifyApiKeysService (webhook HMAC validation)
 *   WalletModule          — OrderRefundService (admin-triggered refund pipeline ONLY)
 *
 * DOES NOT IMPORT:
 *   EscrowModule directly     — accessed via OrderRefundService
 *   RazorpayService directly  — accessed via PaymentGatewayService in WalletModule
 *   SupplierModule            — return system never touches supplier state
 *
 * INVARIANT:
 *   OrderRefundService is exposed to ReturnRequestService via 'ORDER_REFUND_SERVICE'
 *   token. It is ONLY reachable through adminPerformAction → APPROVED_MANUALLY →
 *   triggerManualRefund() with superadmin RBAC + 'CONFIRM_REFUND' phrase.
 *   It is NEVER called from webhook handlers or customer endpoints.
 */

import { Module }                       from '@nestjs/common';
import { MulterModule }                 from '@nestjs/platform-express';

// Services
import { ReturnRequestService }         from './services/return-request.service';
import { ReturnFraudDetectionService }  from './services/return-fraud-detection.service';
import { ReturnEvidenceStorageService } from './services/return-evidence-storage.service';
import { ReturnAuditService }           from './services/return-audit.service';

// Controllers
import { ReturnRequestController }         from './controllers/return-request.controller';
import { AdminReturnModerationController } from './controllers/admin-return-moderation.controller';
import { ShopifyReturnInterceptController } from './controllers/shopify-return-intercept.controller';

// Existing module imports — REUSE, never duplicate
import { TelegramStorageModule }  from '../telegram-storage/telegram-storage.module';
import { ShopifyModule }          from '../shopify/shopify.module';
import { WalletModule }           from '../wallet/wallet.module';
import { OrderRefundService }     from '../wallet/order-refund.service';

@Module({
  imports: [
    // In-memory file uploads for evidence (max 20 MB per file)
    MulterModule.register({ limits: { fileSize: 20 * 1_024 * 1_024 } }),

    // Evidence file storage — reuses Telegram CDN infrastructure
    TelegramStorageModule,

    // HMAC validation for Shopify webhook intercept
    ShopifyModule,

    // Admin-triggered refund pipeline (Razorpay → wallet → escrow)
    // CRITICAL: OrderRefundService is exposed ONLY through 'ORDER_REFUND_SERVICE' token.
    //           It is injected @Optional() in ReturnRequestService and is NEVER called
    //           automatically — only via superadmin triggerManualRefund() action.
    WalletModule,
  ],

  providers: [
    // Core return lifecycle service
    ReturnRequestService,

    // Fraud detection — flags only, never blocks, never acts
    ReturnFraudDetectionService,

    // Evidence storage — Telegram CDN, internal refs never exposed to customers
    ReturnEvidenceStorageService,

    // Immutable audit trail — append-only, records what was PREVENTED
    ReturnAuditService,

    // Token alias so ReturnRequestService can inject OrderRefundService
    // without creating a hard circular dependency on WalletModule internals.
    // This is the SOLE financial action bridge in the return system.
    {
      provide:  'ORDER_REFUND_SERVICE',
      useExisting: OrderRefundService,
    },
  ],

  controllers: [
    // Customer: submit + track returns, upload evidence
    ReturnRequestController,

    // Admin: full moderation workspace, approve/reject, manual refund
    AdminReturnModerationController,

    // Shopify: webhook override — intercepts auto-refund/return/cancellation
    ShopifyReturnInterceptController,
  ],

  exports: [
    ReturnRequestService,
    ReturnAuditService,
  ],
})
export class ReturnShieldModule {}
