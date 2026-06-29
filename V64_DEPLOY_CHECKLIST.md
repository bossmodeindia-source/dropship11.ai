# AI Empire V64 — Complete Deployment Checklist
## Vercel · Railway · Supabase · Telegram — Zero Gaps

---

## Architecture Recap

```
Browser / Mobile
     │
     ▼
[Vercel] ── Next.js frontend (frontend/)
     │       └── next.config.ts rewrites /api/* → Railway API
     ▼
[Railway — API Service]         ← railway.toml
     │  node dist/src/main.js   NestJS port 3000
     │  releaseCommand: node dist/scripts/migrate.js   ← runs before every deploy
     │
[Railway — Worker Service]      ← railway.worker.toml
     │  node dist/src/worker.js  BullMQ consumers
     │
[Supabase PostgreSQL]  ← DATABASE_URL (pgbouncer :6543)
[Railway Redis]        ← REDIS_URL (auto-injected)
[Telegram Bot Pool]    ← tokens AES-256 encrypted in DB
```

---

## STEP 1 — Generate Secrets (run once, store in password manager)

```bash
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
echo "ENCRYPTION_MASTER_KEY=$(openssl rand -hex 32)"
echo "WEBHOOK_HMAC_SECRET=$(openssl rand -hex 32)"
echo "INTERNAL_SERVICE_KEY=$(openssl rand -hex 32)"
```

---

## STEP 2 — Supabase Setup

1. https://supabase.com/dashboard → **New Project**
2. **Project Settings → Database → Connection string** — copy TWO URLs:

| Variable | Mode | Port | When used |
|----------|------|------|-----------|
| `DATABASE_URL` | Transaction (pgbouncer) | **6543** | API + Worker runtime |
| `DATABASE_URL_DIRECT` | Session | **5432** | Migrations only |

3. **Run all migrations** (local, session mode):

```bash
git clone <your-repo>
cd aiempire-v64-fixed
npm ci
export DATABASE_URL_DIRECT="postgresql://postgres:[pass]@db.[ref].supabase.co:5432/postgres"
npx ts-node -r tsconfig-paths/register scripts/migrate.ts
# Applies 000_init → 001_payment → ... → 011_v64_wallet → 012_v64_return_shield
```

Expected output:
```
✅ APPLY 011_v64_wallet.sql
✅ APPLY 012_v64_return_shield.sql
✅ Done — applied: 13, skipped: 0
```

> ⚠️ Never use `DATABASE_URL` (pgbouncer) for migrations — DDL fails on transaction mode.

---

## STEP 3 — Railway Setup

### 3a. Create Project
1. https://railway.app → **New Project → Deploy from GitHub** → select your repo

### 3b. Add Redis
- **New → Database → Redis** — Railway auto-injects `REDIS_URL` into all services

### 3c. API Service

**Variables → Raw Editor** — paste all of these:

```env
NODE_ENV=production
DATABASE_URL=postgresql://postgres.[ref]:[pass]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
DATABASE_URL_DIRECT=postgresql://postgres:[pass]@db.[ref].supabase.co:5432/postgres
DATABASE_SSL=true

JWT_SECRET=<generated-step-1>
JWT_REFRESH_SECRET=<generated-step-1>
ENCRYPTION_MASTER_KEY=<generated-step-1>
WEBHOOK_HMAC_SECRET=<generated-step-1>
SHOPIFY_WEBHOOK_SECRET=<from-shopify-partner-dashboard>
INTERNAL_SERVICE_KEY=<generated-step-1>

ALLOWED_ORIGINS=https://app.yourdomain.com,https://yourdomain.com
APP_BASE_URL=https://app.yourdomain.com
PLATFORM_SIGNUP_URL=https://app.yourdomain.com/signup

# Telegram (admin alerts + Login Widget + storage CDN)
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_ADMIN_CHAT_ID=<your-admin-group-id>
TELEGRAM_STORAGE_MASTER_BOT_TOKEN=<storage-bot-token>

# Razorpay (required for subscriptions + Return Shield manual refunds)
RAZORPAY_KEY_ID=<razorpay-key>
RAZORPAY_KEY_SECRET=<razorpay-secret>
RAZORPAY_WEBHOOK_SECRET=<razorpay-webhook-secret>

# AI
AI_MEDIA_API_KEY=<muapi-key>
AI_MEDIA_BASE_URL=https://api.muapi.ai

# Optional
RESEND_API_KEY=<resend-key>
EMAIL_FROM=noreply@yourdomain.com
SWAGGER_ENABLED=false
CHAOS_MODE=false
```

**Settings → Config as Code** → `railway.toml` (default)

> The `releaseCommand` in `railway.toml` runs `node dist/scripts/migrate.js` before every
> deploy — all pending migrations (including future V65+) apply automatically.

### 3d. Worker Service
1. **New Service → Same GitHub repo**
2. **Settings → Config as Code** → Config File Path: `railway.worker.toml`
3. **Variables → Reference Variables from API service** (shares all env vars)

### 3e. Custom Domain
- API service → **Settings → Domains** → add `api.yourdomain.com`
- Update DNS CNAME → Railway's `.up.railway.app` domain

---

## STEP 4 — Vercel Setup (Frontend)

> The NestJS backend **must never** be deployed to Vercel. Only `frontend/` goes here.

1. https://vercel.com → **New Project** → import repo → **Root Directory: `frontend`**
2. Framework Preset: **Next.js** (auto-detected)
3. **Environment Variables**:

```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_APP_NAME=AI Empire
NEXT_PUBLIC_TELEGRAM_BOT_NAME=YourBotUsername
```

4. Deploy.

The `next.config.ts` rewrites `/api/*` → `${NEXT_PUBLIC_API_URL}/api/*` automatically.
No hardcoded domain anywhere. ✅

---

## STEP 5 — Telegram Login Widget

In your Supabase DB or Railway Variables, `TELEGRAM_BOT_TOKEN` must be set.

1. Create bot: `@BotFather → /newbot`
2. Run `@BotFather → /setdomain → your-domain.com` (required for Login Widget)
3. The login page (`frontend/src/app/page.tsx`) renders the widget automatically when
   `NEXT_PUBLIC_TELEGRAM_BOT_NAME` is set.

Auth flow:
```
User clicks "Login with Telegram"
  → Telegram sends signed user data to window.onTelegramAuth()
  → POST /api/v1/auth/telegram  (frontend/src/lib/api.ts → auth.telegramLogin)
  → NestJS verifies HMAC using TELEGRAM_BOT_TOKEN
  → Returns JWT access + refresh tokens
  → Stored in localStorage, used for all subsequent requests
```

---

## STEP 6 — Telegram Storage Setup (for Return Shield evidence)

After first deploy, register your storage infrastructure:

```bash
API=https://api.yourdomain.com
TOKEN=<admin-jwt>

# Register storage bot
curl -X POST $API/api/v1/admin/storage/bots/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"botName":"StorageBot1","botUsername":"your_storage_bot","botToken":"...","maxCapacity":100}'

# Register evidence storage channel
curl -X POST $API/api/v1/admin/storage/channels \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channelName":"ReturnEvidence","rawChannelId":"-100xxxxxxxxx","channelType":"document"}'
```

Evidence files uploaded via `POST /api/v1/returns/:id/evidence` are stored in Telegram CDN.
Only metadata (no Telegram file IDs) is ever returned to customers. ✅

---

## STEP 7 — Shopify Webhook Registration (Return Shield intercept)

In Shopify Admin → **Settings → Notifications → Webhooks**, register:

| Topic | Endpoint |
|-------|----------|
| `refunds/create` | `POST https://api.yourdomain.com/webhooks/shopify/return-shield/refunds/intercept` |
| `returns/create` | `POST https://api.yourdomain.com/webhooks/shopify/return-shield/returns/intercept` |
| `orders/cancelled` | `POST https://api.yourdomain.com/webhooks/shopify/return-shield/orders/cancelled` |

> ⚠️ If a previous `ShopifyReturnWebhookController` was registered for these topics,
> remove those registrations first. The V64 intercept controller replaces it entirely.

---

## STEP 8 — Verify End-to-End

```bash
# 1. Health check
curl https://api.yourdomain.com/health
# Expected: {"status":"ok","info":{"postgres":{"status":"up"},"redis":{"status":"up"}}}

# 2. Migrations applied
curl https://api.yourdomain.com/health  # no DB errors = migrations ran

# 3. Auth flow
curl -X POST https://api.yourdomain.com/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"Test1234!","fullName":"Test User"}'
# Expected: {"accessToken":"...","refreshToken":"...","user":{...}}

# 4. Return Shield (customer)
curl -X POST https://api.yourdomain.com/api/v1/returns \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<uuid>","reason":"Product damaged on arrival"}'
# Expected: {"id":"...","status":"RETURN_PROCESSING",...}

# 5. Return Shield admin queue
curl https://api.yourdomain.com/admin/returns \
  -H "Authorization: Bearer <admin-token>"
# Expected: {"data":[...],"total":1}
```

---

## STEP 9 — CI/CD Verification

The updated `.github/workflows/ci.yml` now includes V64 integrity checks:

| Check | What it verifies |
|-------|-----------------|
| `V64 — ReturnShieldModule in app.module` | Module registered ✅ |
| `V64 — WalletModule in app.module` | Module registered ✅ |
| `V64 — return-shield services exist` | All 4 services present ✅ |
| `V64 — return-shield controllers exist` | All 3 controllers present ✅ |
| `V64 — wallet services exist` | WalletService + OrderRefundService ✅ |
| `V64 — V64 migrations in /migrations/` | 011_ and 012_ present ✅ |
| `V64 — financial safety check` | No auto-refund in customer/webhook controllers ✅ |
| `V64 — migrate:v64 script` | package.json has the script ✅ |

---

## Changes Made (V64 Fix Summary)

| # | File | Problem | Fix |
|---|------|---------|-----|
| 1 | `migrations/011_v64_wallet.sql` | V64 wallet SQL only in `src/database/migrations/`, `migrate.ts` never found it | Copied to `migrations/` with correct sort prefix |
| 2 | `migrations/012_v64_return_shield.sql` | Same — return shield tables never applied by canonical runner | Copied to `migrations/` with correct sort prefix |
| 3 | `package.json` | `migrate:v64` script missing | Added `"migrate:v64": "node src/database/migrations/run-v64-migrations.js"` |
| 4 | `railway.toml` | No auto-migration on deploy — tables could be missing in production | Added `releaseCommand = "node dist/scripts/migrate.js"` |
| 5 | `vercel.json` (root) | Hardcoded `api.aiempirebot.com` — would silently proxy to wrong domain | Removed rewrite; `next.config.ts` handles it via `NEXT_PUBLIC_API_URL` |
| 6 | `.github/workflows/ci.yml` | Zero V64 integrity checks — CI passed even without return-shield | Added 8 V64 checks + fixed migration steps to use canonical runner |
| 7 | `frontend/src/lib/api.ts` | No Returns API endpoints — frontend had no way to call V64 routes | Added full `returns` + `adminReturns` typed API clients |
