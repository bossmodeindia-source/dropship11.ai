import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'staging')
    .default('development'),
  PORT: Joi.number().port().default(3000),

  // JWT
  JWT_SECRET:             Joi.string().min(32).required(),
  JWT_REFRESH_SECRET:     Joi.string().min(32).required(),
  JWT_EXPIRES_IN:         Joi.string().pattern(/^\d+[smhd]$/).default('15m'),
  JWT_REFRESH_EXPIRES_IN: Joi.string().pattern(/^\d+[smhd]$/).default('7d'),

  // Database
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  // Set to 'true' to force SSL on the Postgres connection (auto-detected for Supabase).
  DATABASE_SSL: Joi.string().valid('true', 'false').optional(),

  // Redis — Railway/Upstash provide REDIS_URL; local Docker uses HOST/PORT/PASSWORD.
  // REDIS_URL takes priority when both are set.
  REDIS_URL:      Joi.string().uri({ scheme: ['redis', 'rediss'] }).optional(),
  REDIS_HOST:     Joi.string().hostname().default('localhost'),
  REDIS_PORT:     Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),

  // Webhook
  WEBHOOK_HMAC_SECRET:    Joi.string().min(16).required(),
  // P3 fix: SHOPIFY_WEBHOOK_SECRET is now required in production/staging.
  // In development/test it is optional (graceful degradation: webhook route
  // becomes disabled if unset, rather than crashing the entire API on boot).
  SHOPIFY_WEBHOOK_SECRET: Joi.when('NODE_ENV', {
    is:        Joi.valid('production', 'staging'),
    then:      Joi.string().min(16).required().messages({
      'any.required': 'SHOPIFY_WEBHOOK_SECRET is required in production/staging. Set it in Railway Variables.',
    }),
    otherwise: Joi.string().min(16).optional().allow(''),
  }),

  // P3 fix: INTERNAL_SERVICE_KEY is required at startup — not silently optional.
  // Used by TenantMiddleware to authenticate worker-to-API internal calls.
  // An empty/missing key would silently allow unauthenticated internal bypass.
  // Generate: openssl rand -hex 32
  INTERNAL_SERVICE_KEY: Joi.string().min(32).required().messages({
    'any.required': 'INTERNAL_SERVICE_KEY is required. Generate with: openssl rand -hex 32',
  }),

  // Security: AES-256-GCM Token Encryption
  // Used for Shopify tokens AND admin-injected API keys at rest.
  // Generate: openssl rand -hex 32
  ENCRYPTION_MASTER_KEY: Joi.string().min(32).required(),

  // ── V2 AI Provider Keys — ALL OPTIONAL AT STARTUP ────────────────────────
  // System operates in MOCK / PARTIAL / FULL mode automatically.
  // Keys can also be injected at runtime via POST /admin/keys/set
  // DO NOT set fake values — empty string activates MOCK mode gracefully.
  NVIDIA_BASE_URL:             Joi.string().uri().optional().default('https://integrate.api.nvidia.com/v1'),
  NVIDIA_CHAT_49B_API_KEY:     Joi.string().optional().allow(''),
  NVIDIA_STRATEGY_253B_API_KEY: Joi.string().optional().allow(''),
  NEMOGUARD_API_KEY:           Joi.string().optional().allow(''),
  MUAPI_API_KEY:               Joi.string().optional().allow(''),
  MUAPI_BASE_URL:              Joi.string().uri().optional().default('https://api.muapi.ai'),

  // External APIs
  SUPPLIER_API_URL: Joi.string().uri().default('https://mock-supplier.internal/api'),
  TREND_API_URL:    Joi.string().uri().optional(),
  TREND_API_KEY:    Joi.string().optional(),

  // Email
  RESEND_API_KEY: Joi.string().optional(),
  EMAIL_FROM:     Joi.string().email().default('noreply@dropship-saas.com'),

  // Throttle
  THROTTLE_TTL:   Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),

  // CORS
  ALLOWED_ORIGINS: Joi.string().optional(),

  // Meta Ads
  META_ACCESS_TOKEN:    Joi.string().optional().default('mock'),
  META_APP_SECRET:      Joi.string().optional().allow(''),
  META_AD_ACCOUNT_ID:   Joi.string().optional().default('act_000000000'),
  META_PAGE_ID:         Joi.string().optional().default('000000000'),
  ROAS_SCALE_THRESHOLD: Joi.number().positive().default(2),
  // DEPRECATED — Phase 4 audit replaced fake AOV with real Shopify revenue
  // attribution. This field is retained only for backward compatibility with
  // existing deployments. DO NOT rely on it for new features — use real
  // Shopify order data from ShopifyRevenueService instead.
  // Will be removed in V62.
  META_ASSUMED_AOV: Joi.number().positive().default(50),

  // V11 Event-Sourced Profit Engine feature flag.
  // When true, V11Module is loaded on startup.
  // NOTE: Should only be enabled in production after full V11 validation.
  V11_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // AI Media (MuAPI)
  AI_MEDIA_API_KEY: Joi.when('NODE_ENV', {
    is:   Joi.valid('production', 'staging'),
    then: Joi.string()
      .min(8)
      .invalid('mock')
      .required()
      .messages({
        'any.invalid': 'AI_MEDIA_API_KEY must be a real Muapi key in production/staging',
        'any.required': 'AI_MEDIA_API_KEY is required in production/staging',
      }),
    otherwise: Joi.string().optional().default('mock'),
  }),
  AI_MEDIA_BASE_URL: Joi.string().uri().default('https://api.muapi.ai'),

  // DLQ Alerting
  ADMIN_ALERT_EMAIL: Joi.string().email().default('ops@dropship-saas.com'),

  // Chaos Engineering — NEVER true in production
  CHAOS_MODE: Joi.string().valid('true', 'false').default('false'),

  // ── Razorpay ──────────────────────────────────────────────────────────────
  // Required when SUBSCRIPTION feature is active; optional in non-payment envs.
  RAZORPAY_KEY_ID:      Joi.string().optional().allow(''),
  RAZORPAY_KEY_SECRET:  Joi.string().optional().allow(''),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().optional().allow(''),

  // ── V43 Organic Growth ────────────────────────────────────────────────────
  V43_ORGANIC_MODE:         Joi.string().valid('ORGANIC_ONLY', 'HYBRID', 'ADS_ONLY').default('HYBRID'),
  V43_LOOP_INTERVAL_HOURS:  Joi.number().integer().min(1).max(24).default(6),
  V43_AUTO_START:           Joi.string().valid('true', 'false').default('true'),

  // Instagram Graph API
  INSTAGRAM_ACCESS_TOKEN:   Joi.string().optional().allow(''),
  INSTAGRAM_USER_ID:        Joi.string().optional().allow(''),

  // YouTube Data API v3
  YOUTUBE_API_KEY:          Joi.string().optional().allow(''),
  YOUTUBE_OAUTH_TOKEN:      Joi.string().optional().allow(''),

  // Reddit OAuth2
  REDDIT_CLIENT_ID:         Joi.string().optional().allow(''),
  REDDIT_CLIENT_SECRET:     Joi.string().optional().allow(''),
  REDDIT_USERNAME:          Joi.string().optional().allow(''),
  REDDIT_PASSWORD:          Joi.string().optional().allow(''),
  REDDIT_SUBREDDITS:        Joi.string().optional().default('entrepreneur,ecommerce,dropshipping,marketing'),
  REDDIT_DEFAULT_SUBREDDIT: Joi.string().optional().allow(''),

  // Link tracking base URL
  APP_BASE_URL: Joi.string().uri({ scheme: ['https'] }).default('https://yourstore.com'),

  // ── OPS / Empire (V56) ────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN:        Joi.string().optional().allow(''),
  TELEGRAM_ADMIN_CHAT_ID:    Joi.string().optional().allow(''),
  EMPIRE_MAX_STORES:         Joi.number().integer().min(1).default(20),
  EMPIRE_MAX_EXPOSURE_INR:   Joi.number().positive().default(500000),
  EMPIRE_MAX_DAILY_SPEND:    Joi.number().positive().default(100000),
  EMPIRE_LOSS_THRESHOLD_PCT: Joi.number().min(1).max(100).default(15),
  EMPIRE_SEED_CAPITAL_INR:   Joi.number().positive().default(100000),
});