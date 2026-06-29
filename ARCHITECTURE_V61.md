# AI Empire Bot — V61 Architecture
## Autonomous AI Commerce Operating System

---

## What Changed in V61

V61 adds the complete **Centralized AI Provider Governance** and **Dual AI Execution Layer** architecture on top of the V60 production base.

---

## New Modules

### 1. `AiProviderRegistryModule` (`src/ai-provider-registry/`)

**Admin-only governance** of all AI providers available on the platform.

| Service | Responsibility |
|---|---|
| `AiProviderRegistryService` | CRUD for `ai_provider_catalog` — add/approve/disable providers |
| `ProviderHealthMonitorService` | Scheduled 5-min health checks on all approved providers |

**Rules enforced:**
- ONLY admins can approve/disable/deprecate providers
- Provider approval is logged in `ai_provider_approval_log`
- Disabling a provider cascades to disable all user connections
- 8 providers pre-seeded: OpenAI, Claude, OpenRouter, Flux, Runway, Kling, ElevenLabs, NVIDIA

**Endpoints:**
```
GET    /admin/ai-providers              — list all providers (admin)
POST   /admin/ai-providers              — create provider (admin)
POST   /admin/ai-providers/:id/approve  — approve provider (admin)
POST   /admin/ai-providers/:id/disable  — disable provider (admin)
PATCH  /admin/ai-providers/:id          — update provider (admin)
GET    /admin/ai-providers/health       — health summary (admin)
GET    /api/v1/ai-providers/available   — list APPROVED providers (user — no keys exposed)
```

---

### 2. `UserAiConnectionsModule` (`src/user-ai-connections/`)

**User-owned AI provider keys** — completely isolated from Platform AI Layer.

| Service | Responsibility |
|---|---|
| `UserAiConnectionsService` | Store/retrieve/validate/rotate user API keys (AES-256-GCM) |
| `UserAiRouterService` | Route AI generation to user's own providers — **NEVER admin keys** |

**Security rules enforced:**
- Users can only connect keys for admin-approved providers
- Keys AES-256-GCM encrypted using `ENCRYPTION_MASTER_KEY`
- Decrypted keys live in memory only during the API call
- Keys are **never** returned in any API response
- Each tenant's keys are cryptographically isolated

**AI Routing Priority (per request):**
```
1. User's primary provider for the task category
2. User's secondary provider (if first fails)
3. Platform fallback (ONLY if user explicitly enabled + subscription permits)
4. ForbiddenException — NEVER silently uses admin keys
```

**Supported providers + categories:**

| Provider | Category | Implementation |
|---|---|---|
| OpenAI | reasoning | GPT-4o, GPT-4-Turbo |
| Claude | reasoning | claude-sonnet-4-5, haiku |
| OpenRouter | reasoning | 100+ models |
| NVIDIA NIM | reasoning | Llama-3.1-70B, 405B |
| Flux | image_generation | FLUX.1-pro, FLUX.1-schnell |
| Runway | video_generation | Gen-3 Alpha Turbo |
| Kling | video_generation | Kling 1.5 |
| ElevenLabs | voice | Turbo v2.5 |

**Endpoints:**
```
GET    /api/v1/user/ai-connections               — list connections (no keys)
POST   /api/v1/user/ai-connections/connect       — connect API key
DELETE /api/v1/user/ai-connections/:id           — disconnect
POST   /api/v1/user/ai-connections/:id/health-check — validate key
GET    /api/v1/user/ai-connections/analytics     — usage stats
```

---

### 3. `UserBusinessConnectionsModule` (`src/user-business-connections/`)

**User-owned social/commerce account credentials** — encrypted at rest.

Supported platforms:
- `meta_ads` — Meta Ad Account token + account ID + pixel ID
- `meta_instagram` — Instagram Business Account token
- `meta_facebook_page` — Facebook Page token + page ID
- `tiktok` — TikTok Content Posting API token
- `youtube` — YouTube Data API OAuth token
- `shopify` — Shopify Access Token + store domain
- `whatsapp_business` — WhatsApp Business API token
- `telegram_notify` — Telegram notification chat ID

**All credentials:** AES-256-GCM encrypted before storage. The decrypted values are consumed **only at runtime** by `TenantMetaAdsBridge` and `TenantOrganicPublisherService`.

**Endpoints:**
```
GET    /api/v1/user/business-connections         — list connections
POST   /api/v1/user/business-connections/connect — connect account
DELETE /api/v1/user/business-connections/:id     — disconnect
```

---

### 4. `VideoPipelineModule` (`src/video-pipeline/`)

**Fully autonomous video ad generation** using user's own AI keys.

**Pipeline stages:**
```
1. Script generation      → UserAiRouter → reasoning provider (OpenAI/Claude/OpenRouter)
2. Scene image generation → UserAiRouter → image provider (Flux)
3. Video clip generation  → UserAiRouter → video provider (Runway/Kling)
4. FFmpeg assembly        → server-side (no external provider)
5. Voiceover generation   → UserAiRouter → voice provider (ElevenLabs)
6. Subtitle burn-in       → server-side (Whisper integration planned)
7. Store via Telegram CDN → TelegramStorageOrchestrator
8. Virality scoring       → CreativeScoringService (Thompson Sampling)
9. A/B variants           → up to 3 variants per product
```

**Output stored:** Assembled `.mp4` → Telegram CDN (deduplication + CDN delivery) → `telegram_asset_id` in `video_pipeline_jobs`

**Endpoints:**
```
POST /api/v1/video-pipeline/launch       — enqueue video generation
GET  /api/v1/video-pipeline/jobs         — list jobs
GET  /api/v1/video-pipeline/jobs/:jobId  — get job status + scores
```

---

### 5. `CreativeViralityModule` (`src/creative-virality/`)

**Virality prediction engine** using heuristics + Thompson Sampling.

| Service | Responsibility |
|---|---|
| `CreativeScoringService` | Score hooks, CTA, scenes, hashtags, music — predict CTR + ROAS |

**Scoring dimensions:**
- Hook strength (30% weight) — curiosity gap, emotional triggers, word count
- Scene diversity (20%) — count, prompt depth, style alignment
- CTA effectiveness (15%) — urgency, action verbs, benefit framing
- Platform + style match (15%) — e.g. UGC on TikTok scores highest
- Hashtag relevance (10%) — count, niche alignment
- Music alignment (10%) — platform-specific preferences

**Thompson Sampling:** Beta distribution sampling per A/B variant, updated with each generation's actual performance data fed back via `recordActualPerformance()`.

---

### 6. `TenantMetaAdsBridge` (`src/meta-ads/tenant-meta-ads.bridge.ts`)

**Routes Meta ad campaigns through user's own Meta credentials.**

- User's `META_ACCESS_TOKEN` → fetched from `UserBusinessConnectionsService` at runtime
- User's `META_AD_ACCOUNT_ID` → all ad spend billed to user's payment method
- User's `META_PIXEL_ID` → conversion tracking on user's pixel
- Platform NEVER pays user ad costs

**Capabilities:**
- Full campaign/adset/ad creation
- Budget scaling (INR → USD cents conversion)
- Campaign pause/resume
- Performance insights via Meta Insights API

---

### 7. `TenantOrganicPublisherService` (`src/organic/tenant-organic-publisher.service.ts`)

**Routes organic publishing through user's own social accounts.**

- Instagram Reels → user's `meta_instagram` token
- Facebook Posts → user's `meta_facebook_page` token
- TikTok Videos → user's `tiktok` token (Content Posting API v2)
- YouTube Shorts → user's `youtube` OAuth token (resumable upload)

**Hybrid escalation:** When organic engagement > 3%, triggers paid Meta campaign automatically (using user's own Meta account + budget).

---

## Database Migrations

```
migrations/
├── 001_payment_system.sql
├── 002_v60_finance_orchestrator.sql
├── 003_platform_ads_engine.sql
├── 004_platform_ads_v60_patch.sql
├── 005_telegram_storage.sql
└── 006_ai_provider_governance.sql    ← NEW (V61)
```

Migration 006 adds:
- `ai_provider_catalog` — admin-governed provider registry
- `ai_provider_approval_log` — audit trail for approvals
- `ai_provider_health_snapshots` — 7-day rolling health history
- `user_ai_provider_connections` — user API key vault (encrypted)
- `user_ai_usage_events` — per-tenant token/cost analytics
- `user_business_connections` — user social/commerce account vault (encrypted)
- `ai_provider_requests` — user provider request tickets
- `video_pipeline_jobs` — autonomous video generation tracking
- `organic_publish_jobs` — organic posting + engagement tracking
- **8 pre-seeded approved providers** (OpenAI, Claude, OpenRouter, Flux, Runway, Kling, ElevenLabs, NVIDIA)

---

## Security Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  PLATFORM AI LAYER (Admin-Owned Keys)                       │
│  ┌──────────────────────┐  ┌──────────────────────────────┐ │
│  │  ConfigVaultService  │  │  AiOrchestratorService       │ │
│  │  (admin keys only)   │  │  (NVIDIA 49B/253B + BotMode) │ │
│  └──────────────────────┘  └──────────────────────────────┘ │
│  Used ONLY for: SaaS growth ads, demos, admin analytics     │
│  Users CANNOT access this layer                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  USER AI LAYER (User-Owned Keys)                            │
│  ┌──────────────────────┐  ┌──────────────────────────────┐ │
│  │ UserAiConnectionsSvc │  │  UserAiRouterService         │ │
│  │ (AES-256 encrypted)  │  │  (routes to user providers)  │ │
│  └──────────────────────┘  └──────────────────────────────┘ │
│  Used for: ALL user campaigns, videos, organic posting      │
│  Admin keys NEVER accessed from this layer                  │
└─────────────────────────────────────────────────────────────┘

Isolation guarantee:
  UserAiRouterService has NO dependency on ConfigVaultService
  UserAiConnectionsService has NO dependency on AiOrchestratorService
  AiProviderRegistryService only governs catalog — never stores user keys
```

---

## Autonomous Commerce Flow (V61 Complete)

```
1. Market Intelligence (existing: v26 DataAggregator, v34 CompetitorIntelligence)
2. Product Discovery  (existing: ProductDiscoveryService, AmazonScanner)
3. Niche Selection    (existing: NicheDomainService, CategoryIntelligenceService)
4. Pricing Decision   (existing: SmartPricingEngine, CommissionModule)

5. Video Generation [NEW — User AI Layer]
   ├── Script         → UserAiRouter → user's OpenAI/Claude/OpenRouter key
   ├── Scene Images   → UserAiRouter → user's Flux key
   ├── Video Clips    → UserAiRouter → user's Runway/Kling key
   ├── Voiceover      → UserAiRouter → user's ElevenLabs key
   ├── Assembly       → FFmpeg (server-side)
   ├── Storage        → TelegramStorageOrchestrator
   └── Scoring        → CreativeScoringService (virality + CTR prediction)

6. Organic Publishing [NEW — User Social Accounts]
   ├── Instagram Reels → user's meta_instagram token
   ├── TikTok Videos   → user's tiktok token
   └── YouTube Shorts  → user's youtube token

7. Paid Ads [NEW — User Meta Account]
   ├── Campaign Launch → TenantMetaAdsBridge → user's meta_ads token
   ├── Ad Spend        → billed to user's Meta payment method (NEVER platform)
   └── ROAS Tracking   → MetaPerformanceService → user's pixel

8. Shopify Automation  (existing: ShopifyService, ShopifyOrderSyncService)
9. Supplier Fulfillment (existing: SupplierModule, CommissionModule)
10. AI Learning Loop   (existing: WinnerDnaService, MultiArmedBandit, CreativeEvolution)
```

---

## FFmpeg Requirement

The `VideoPipelineOrchestrator` requires FFmpeg installed on the server for video assembly.

**Docker:** Add to Dockerfile:
```dockerfile
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
```

**Railway / Nixpacks:** Add to `nixpacks.toml`:
```toml
[phases.setup]
nixPkgs = ["...", "ffmpeg"]
```

---

## Running Migration 006

```bash
# Run all pending migrations (including 006)
npm run db:migrate:sql

# Or manually:
DATABASE_URL=postgresql://... npx ts-node -r tsconfig-paths/register scripts/migrate.ts
```
