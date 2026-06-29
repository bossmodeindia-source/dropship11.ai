# V64 — AI Empire Bot: Controlled Return Shield System

## Overview

The **Return Shield** is a controlled, admin-governed return pipeline that:

- **Preserves storefront trust** — customers see a "Return Product" button and friendly UI
- **Prevents all automatic financial actions** — zero auto-refund, zero auto-supplier reversal
- **Holds every return in `RETURN_PROCESSING`** until admin explicitly intervenes
- **Full fraud detection** — flags `HIGH_RISK_RETURN` without blocking submission
- **Immutable audit trail** — every action logged, including what was *prevented*

---

## What's New in V64

### New Modules

| Module | Purpose |
|--------|---------|
| `ReturnShieldModule` | Core return pipeline + all sub-services |
| `WalletModule` | User wallet ledger + `OrderRefundService` |

### New Files

```
src/
├── return-shield/
│   ├── return-shield.module.ts              # NestJS module
│   ├── return-shield.schema.ts              # Drizzle schema definitions
│   ├── return-shield.migration.sql          # Raw SQL migration
│   ├── dto/
│   │   └── return-shield.dto.ts             # All DTOs + status mapper
│   ├── services/
│   │   ├── return-request.service.ts        # Core lifecycle (financial contract)
│   │   ├── return-fraud-detection.service.ts # Abuse scoring + risk flags
│   │   ├── return-evidence-storage.service.ts # Telegram CDN evidence
│   │   └── return-audit.service.ts          # Immutable audit trail
│   └── controllers/
│       ├── return-request.controller.ts     # Customer API
│       ├── admin-return-moderation.controller.ts # Admin workspace
│       └── shopify-return-intercept.controller.ts # Shopify override
├── wallet/                                  # V64 wallet (from original V64)
│   ├── wallet.module.ts
│   ├── wallet.service.ts
│   ├── wallet-schema.ts
│   ├── wallet.controller.ts
│   └── order-refund.service.ts
└── database/migrations/
    ├── add_wallet_tables.sql
    ├── add_return_shield_tables.sql         # NEW
    └── run-v64-migrations.js               # Migration runner
```

---

## Financial Safety Contract

### What NEVER happens automatically

| Action | Status |
|--------|--------|
| Razorpay/gateway refund | ❌ NEVER automatic |
| Shopify financial status update | ❌ NEVER automatic |
| Supplier order reversal | ❌ NEVER automatic |
| Inventory sync/reversal | ❌ NEVER automatic |
| Escrow state modification | ❌ NEVER automatic |
| Commission/payout rollback | ❌ NEVER automatic |
| Customer wallet credit | ❌ NEVER automatic |

### What CAN happen (admin-only)

| Action | Requirement |
|--------|------------|
| Status change | `admin` or `superadmin` role |
| Approve return | `admin` or `superadmin` |
| Reject return | `admin` or `superadmin` |
| Trigger refund | `superadmin` + `confirmationPhrase: "CONFIRM_REFUND"` + `APPROVED_MANUALLY` status |

---

## Return Status Pipeline

```
Customer submits → RETURN_PROCESSING (default, perpetual)
                        ↓ (admin action only)
               UNDER_ADMIN_REVIEW
                        ↓
          WAITING_INTERNAL_APPROVAL
                  ↙              ↘
           REJECTED          APPROVED_MANUALLY
                                    ↓ (superadmin + CONFIRM_REFUND)
                        REFUND_MANUALLY_PROCESSED
                                    ↓
                               CLOSED
```

**Customer always sees:** "Your return request is currently being reviewed."
**Status shown to customer:** `processing` / `approved` / `rejected` / `closed`

---

## Setup

### 1. Run Migrations

```bash
DATABASE_URL=postgres://... node src/database/migrations/run-v64-migrations.js
```

Or add to `package.json`:
```json
"scripts": {
  "migrate:v64": "node src/database/migrations/run-v64-migrations.js"
}
```

### 2. Register Shopify Webhooks

In Shopify admin → Settings → Notifications → Webhooks, register:

| Topic | Endpoint |
|-------|---------|
| `refunds/create` | `POST https://your-domain/webhooks/shopify/return-shield/refunds/intercept` |
| `returns/create` | `POST https://your-domain/webhooks/shopify/return-shield/returns/intercept` |
| `orders/cancelled` | `POST https://your-domain/webhooks/shopify/return-shield/orders/cancelled` |

> ⚠️ **IMPORTANT**: If the previous `ShopifyReturnWebhookController` is registered
> for these topics, **remove those registrations** or disable that controller.
> The new intercept controller replaces it entirely.

### 3. Environment Variables

No new env vars required. Reuses:
- `SHOPIFY_WEBHOOK_SECRET` — fallback HMAC secret
- `DATABASE_URL` — PostgreSQL connection
- All existing Redis / Telegram config

---

## API Reference

### Customer Endpoints

```
POST   /api/v1/returns              # Submit return request
GET    /api/v1/returns              # List my returns
GET    /api/v1/returns/:id          # Get return status (customer-safe)
POST   /api/v1/returns/:id/evidence # Upload evidence files
GET    /api/v1/returns/:id/evidence # List evidence (no internal refs)
```

### Admin Endpoints

```
GET    /admin/returns                    # Return moderation queue
GET    /admin/returns/stats              # Queue statistics
GET    /admin/returns/audit/export       # Compliance export (superadmin)
GET    /admin/returns/:id                # Full return details
PATCH  /admin/returns/:id/action         # Approve/Reject/Freeze/Close/Note
POST   /admin/returns/:id/refund         # Trigger manual refund (superadmin)
GET    /admin/returns/:id/evidence       # Evidence with Telegram CDN refs
POST   /admin/returns/:id/evidence       # Upload admin-only evidence
GET    /admin/returns/:id/audit          # Return audit trail
GET    /admin/returns/:id/fraud-analysis # Re-run fraud detection
```

### Shopify Webhook Intercept

```
POST   /webhooks/shopify/return-shield/refunds/intercept   # Blocks auto-refund
POST   /webhooks/shopify/return-shield/returns/intercept   # Blocks auto-inventory
POST   /webhooks/shopify/return-shield/orders/cancelled    # Blocks auto-cancel refund
```

---

## Fraud Detection Signals

| Signal Code | Trigger | Weight |
|-------------|---------|--------|
| `DUPLICATE_RETURN` | Existing active return for same order | 50 |
| `REPEAT_RETURNER` | 5+ returns in 90 days | 20–40 |
| `PREVIOUS_REJECTIONS` | 2+ rejected returns | 25 |
| `HIGH_APPROVED_RETURNS` | 3+ approved refunds in 90 days | 15 |
| `HIGH_RETURN_RATE` | ≥50% return rate vs orders | 20–35 |
| `RETURNS_WITHOUT_ORDERS` | Returns with no matching orders | 30 |
| `IMMEDIATE_RETURN` | Return within 24h of order | 20 |
| `ALREADY_REFUNDED_ORDER` | Order already marked refunded | 45 |
| `HIGH_VALUE_RETURN` | Order ≥ ₹5,000 | 10–25 |
| `RAPID_RETURN_SUBMISSIONS` | 3+ returns in 24 hours | 25–40 |

**Risk Thresholds:**
- Score 0–29 → `LOW`
- Score 30–59 → `MEDIUM`
- Score 60+ → `HIGH_RISK_RETURN` (flagged for priority admin review)

---

## Evidence Storage Security

- Files stored in **Telegram CDN** via existing `TelegramStorageModule`
- **Only metadata** stored in PostgreSQL (`return_evidence` table)
- `telegram_file_id`, `telegram_msg_id`, `telegram_channel` — admin-only, encrypted
- Customer API returns **sanitized view** — no Telegram references ever exposed
- Admin API returns **full view** with internal storage references

---

## Audit Trail

Every action is recorded in `return_audit_logs` (append-only, never updated):

- Return creation (with `auto_refund_prevented = TRUE`)
- All status changes (with before/after state)
- Every admin action (with actor + IP + timestamp)
- Shopify webhook interceptions (with what was prevented)
- Evidence uploads
- Manual refund triggers
- Risk flag events

Export via: `GET /admin/returns/audit/export` (superadmin only)
