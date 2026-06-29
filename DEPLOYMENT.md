# AI Empire V63 — Production Deployment Guide
## Vercel (Frontend) + Railway (Backend API + Worker) + Supabase (Database) + Telegram (Storage + Auth)

---

## Architecture

```
Browser / Mobile App
        │
        ▼
[Vercel] ─── Next.js / React frontend
        │    └── /api/* → proxied to Railway API (vercel.json rewrites)
        ▼
[Railway — API Service]      ← railway.toml
        │    └── node dist/src/main.js   (NestJS, port 3000)
        │    └── GET /health             (liveness probe)
        │    └── GET /metrics            (Prometheus)
        │
[Railway — Worker Service]   ← railway.worker.toml
        │    └── node dist/src/worker.js (BullMQ consumers)
        │
[Supabase — PostgreSQL]  ← DATABASE_URL (pgbouncer transaction mode)
[Railway — Redis]        ← REDIS_URL (BullMQ + tenant cache + locks)
[Telegram Bot Pool]      ← bot tokens in DB (AES-256 encrypted)
```

---

## Step 1 — Generate Secrets

Run locally. Store in your password manager.

```bash
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
echo "ENCRYPTION_MASTER_KEY=$(openssl rand -hex 32)"
echo "WEBHOOK_HMAC_SECRET=$(openssl rand -hex 32)"
echo "INTERNAL_SERVICE_KEY=$(openssl rand -hex 32)"
```

---

## Step 2 — Supabase Setup

1. https://supabase.com/dashboard → New Project
2. **Project Settings → Database → Connection string** — get TWO URLs:

| Purpose | Mode | Port | URL type |
|---------|------|------|----------|
| App (API + Worker) | Transaction mode (pgbouncer) | 6543 | `DATABASE_URL` |
| Migrations only | Session mode | 5432 | `DATABASE_URL_DIRECT` |

3. **Run migrations** (local, with session-mode URL):
```bash
git clone <your-repo>
cd aiempire-v63-integrated
npm ci
export DATABASE_URL_DIRECT="postgresql://postgres:[pass]@db.[ref].supabase.co:5432/postgres"
npm run db:migrate:sql
```

---

## Step 3 — Railway Setup

### 3a. Create Project
1. https://railway.app → New Project → Deploy from GitHub

### 3b. Add Redis
In your Railway project → **New → Database → Redis**  
Railway auto-injects `REDIS_URL` into all services.

### 3c. API Service
1. New Service → GitHub repo (main branch)
2. Settings → Config as Code → `railway.toml` (default)

### 3d. API Environment Variables (Railway Dashboard → Variables → Raw Editor)

```env
NODE_ENV=production
DATABASE_URL=postgresql://postgres.[ref]:[pass]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
JWT_SECRET=<generated>
JWT_REFRESH_SECRET=<generated>
ENCRYPTION_MASTER_KEY=<generated>
WEBHOOK_HMAC_SECRET=<generated>
SHOPIFY_WEBHOOK_SECRET=<from Shopify Partner dashboard>
INTERNAL_SERVICE_KEY=<generated>
ALLOWED_ORIGINS=https://app.yourdomain.com
META_INR_TO_USD_RATE=0.012
EMPIRE_MAX_DAILY_SPEND=100000
PLATFORM_ASSUMED_LTV_INR=3000
PLATFORM_SIGNUP_URL=https://app.yourdomain.com/signup
APP_BASE_URL=https://app.yourdomain.com
AI_MEDIA_API_KEY=<your MuAPI key>
ADMIN_ALERT_EMAIL=ops@yourdomain.com

# Optional — Telegram
TELEGRAM_BOT_TOKEN=<your bot token for admin alerts + login widget>
TELEGRAM_ADMIN_CHAT_ID=<your admin group chat ID>
TELEGRAM_STORAGE_MASTER_BOT_TOKEN=<dedicated storage bot token>

# Optional — Razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

### 3e. Worker Service
1. New Service → Same GitHub repo
2. Settings → Config as Code → `railway.worker.toml`
3. Variables → **Share variables from API service**

### 3f. Custom Domains
- API service → Settings → Domains → `api.yourdomain.com`
- Update DNS CNAME → Railway's domain

---

## Step 4 — Vercel Setup (Frontend)

> **Important**: This NestJS backend must NOT be deployed to Vercel serverless.
> Vercel only hosts your Next.js/React frontend.

1. https://vercel.com → New Project → import your **frontend** repo
2. Set environment variables:
```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_APP_NAME=AI Empire
```
3. In your frontend's `vercel.json`, update the rewrite destination:
```json
{
  "rewrites": [{ "source": "/api/:path*", "destination": "https://api.yourdomain.com/api/:path*" }]
}
```

---

## Step 5 — Telegram Login Widget Setup

To enable Telegram auth (`POST /api/v1/auth/telegram`):

1. Create a bot via @BotFather: `/newbot`
2. Set `TELEGRAM_BOT_TOKEN` in Railway Variables
3. In your frontend, add the Telegram Login Widget:
```html
<script
  async
  src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="YourBotName"
  data-size="large"
  data-onauth="onTelegramAuth(user)"
  data-request-access="write"
></script>
<script>
function onTelegramAuth(user) {
  fetch('/api/v1/auth/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  }).then(r => r.json()).then(data => {
    localStorage.setItem('accessToken', data.accessToken);
    // redirect to dashboard
  });
}
</script>
```

Or use redirect mode pointing to: `GET /api/v1/auth/telegram/callback`

---

## Step 6 — Telegram Storage Setup (Optional)

After first deploy:

1. Create private Telegram channels (one per content type: images, videos, etc.)
2. Add your storage bot as admin with full permissions
3. Register bots via API:
```bash
curl -X POST https://api.yourdomain.com/api/v1/admin/storage/bots/register \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"botName":"StorageBot1","botUsername":"your_storage_bot","botToken":"...","maxCapacity":100}'
```
4. Register channels:
```bash
curl -X POST https://api.yourdomain.com/api/v1/admin/storage/channels \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"channelName":"Images","rawChannelId":"-100xxx","channelType":"image"}'
```

---

## Step 7 — Verify Deployment

```bash
# Health check
curl https://api.yourdomain.com/health

# Expected response:
# {"status":"ok","info":{"postgres":{"status":"up"},"redis":{"status":"up"}},"details":{...}}

# Swagger UI (if SWAGGER_ENABLED=true)
open https://api.yourdomain.com/api/docs
```

---

## Key Bug Fixes in This Build (V63 Production)

| # | Bug | Fix |
|---|-----|-----|
| 1 | `railway.toml` start cmd: `dist/main.js` → should be `dist/src/main.js` | Fixed |
| 2 | `railway.worker.toml` same wrong path | Fixed |
| 3 | `nixpacks.toml` same wrong path | Fixed |
| 4 | Migration `0010_creative_arms_thompson.sql` ran before `001_` (sort order) | Renamed to `010_` |
| 5 | `HealthController` registered twice (AppModule + HealthModule) | Removed duplicate |
| 6 | `auth.service.ts` register audit call missing `severity` field | Fixed |
| 7 | No Telegram Login Widget authentication | Added `TelegramAuthService` + endpoints |
| 8 | `worker.ts` missing `configValidationSchema` (no validation on boot) | Fixed |
| 9 | `worker.ts` missing `CryptoModule` (workers need `EncryptionService`) | Fixed |
| 10 | `worker.ts` graceful shutdown didn't await `app.close()` | Fixed |
| 11 | Missing `drizzle.config.ts` for schema push | Added |
| 12 | `vercel.json` had hardcoded `$NEXT_PUBLIC_API_URL` as literal string | Cleaned up |
| 13 | `main.ts` Swagger version said "61.1.0" on V63 build | Fixed to 63.0.0 |
| 14 | `scripts/migrate.ts` path resolution broke in compiled JS | Fixed with `__dirname` |
| 15 | No `db:migrate:prod` script for compiled JS migration runner | Added |
