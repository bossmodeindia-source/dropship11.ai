/**
 * api.ts — Typed API client for AI Empire V64 backend
 * All requests go through /api/* → proxied to Railway by Next.js rewrites.
 *
 * FIX (v64): Added automatic 401 → refresh-token rotation so expired access
 * tokens are refreshed transparently instead of crashing the UI.
 */

const BASE = '/api/v1';

// ── Token helpers ────────────────────────────────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    fullName: string | null;
    subscriptionTier: string;
  };
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export function saveTokens(tokens: AuthTokens): void {
  localStorage.setItem('access_token', tokens.accessToken);
  localStorage.setItem('refresh_token', tokens.refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
}

export function getAccessToken(): string | null {
  return typeof window !== 'undefined'
    ? localStorage.getItem('access_token')
    : null;
}

function getRefreshToken(): string | null {
  return typeof window !== 'undefined'
    ? localStorage.getItem('refresh_token')
    : null;
}

// ── Core request (with auto-refresh on 401) ──────────────────────────────────

let _refreshing: Promise<AuthTokens> | null = null;

async function request<T>(
  path: string,
  opts: RequestInit & { _retry?: boolean } = {},
): Promise<T> {
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((opts.headers as Record<string, string>) ?? {}),
  };

  // Remove Content-Type for FormData (let browser set multipart boundary)
  if (opts.body instanceof FormData) {
    delete headers['Content-Type'];
  }

  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers,
  });

  // ── Auto-refresh on 401 (only once per request to avoid loops) ───────────
  if (res.status === 401 && !opts._retry) {
    const rt = getRefreshToken();
    if (rt) {
      try {
        // Deduplicate concurrent refreshes into a single in-flight request
        if (!_refreshing) {
          _refreshing = fetch(`${BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: rt }),
          })
            .then((r) => r.json())
            .finally(() => { _refreshing = null; });
        }
        const newTokens: AuthTokens = await _refreshing;
        if (newTokens?.accessToken) {
          saveTokens(newTokens);
          // Retry the original request with the new token
          return request<T>(path, { ...opts, _retry: true });
        }
      } catch {
        // Refresh failed — clear tokens and let caller handle redirect
      }
    }
    clearTokens();
    if (typeof window !== 'undefined') window.location.href = '/';
    throw new Error('Session expired. Please sign in again.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? 'Request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const auth = {
  login: (email: string, password: string) =>
    request<AuthTokens>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string, fullName?: string) =>
    request<AuthTokens>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, fullName }),
    }),
  telegramLogin: (user: TelegramUser) =>
    request<AuthTokens>('/auth/telegram', {
      method: 'POST',
      body: JSON.stringify(user),
    }),
  refresh: (refreshToken: string) =>
    request<AuthTokens>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<AuthTokens['user']>('/auth/me'),
};

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface DashboardSummary {
  revenueToday: number;
  activeOrders: number;
  productsListed: number;
  roas: number | null;
  currency: string;
}

export const dashboard = {
  summary: () => request<DashboardSummary>('/dashboard/summary'),
};

// ── Products ──────────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  title: string;
  price: number;
  currency: string;
  status: string;
  score: number | null;
  shopifyProductId: string | null;
  createdAt: string;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export const products = {
  list: (page = 1, limit = 20) =>
    request<Paginated<Product>>(`/products?page=${page}&limit=${limit}`),
};

// ── Orders ────────────────────────────────────────────────────────────────────

export interface Order {
  id: string;
  shopifyOrderId: string | null;
  status: string;
  totalPrice: number;
  currency: string;
  customerEmail: string | null;
  createdAt: string;
}

export const orders = {
  list: (page = 1, limit = 20) =>
    request<Paginated<Order>>(`/orders?page=${page}&limit=${limit}`),
};

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface AnalyticsSnapshot {
  roas: number | null;
  cac: number | null;
  ltv: number | null;
  revenueTotal: number;
  adSpend: number;
  conversionRate: number | null;
  currency: string;
  periodDays: number;
}

export const analytics = {
  snapshot: (days = 7) =>
    request<AnalyticsSnapshot>(`/analytics/snapshot?days=${days}`),
};

// ── Campaigns ─────────────────────────────────────────────────────────────────

export interface Campaign {
  id: string;
  name: string;
  status: string;
  platform: string;
  budget: number;
  spent: number;
  roas: number | null;
  currency: string;
  createdAt: string;
}

export const campaigns = {
  list: (page = 1, limit = 20) =>
    request<Paginated<Campaign>>(`/campaigns?page=${page}&limit=${limit}`),
};

// ── Integrations ──────────────────────────────────────────────────────────────

export interface Integration {
  platform: string;
  connected: boolean;
  shopName?: string;
  adAccountId?: string;
  lastSync?: string;
}

export const integrations = {
  status: () => request<Integration[]>('/integrations/status'),
  connectShopify: (apiKey: string, shop: string) =>
    request<{ ok: boolean }>('/shopify/connect', {
      method: 'POST',
      body: JSON.stringify({ apiKey, shop }),
    }),
};

// Dynamic Website Platform Management

export interface WebsitePlatformField {
  key?: string;
  name?: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
}

export interface WebsitePlatform {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string | null;
  description?: string | null;
  category: string;
  authType: string;
  apiBaseUrl?: string | null;
  oauthUrl?: string | null;
  tokenUrl?: string | null;
  redirectUrl?: string | null;
  scopes?: string[];
  requiredFields?: WebsitePlatformField[];
  apiVersion?: string | null;
  healthEndpoint?: string | null;
  documentationUrl?: string | null;
  supportedFeatures?: Record<string, boolean>;
  connectionWizard?: Record<string, unknown>;
  enabled: boolean;
  maintenanceMode: boolean;
  isDefault: boolean;
  priority: number;
  fallbackPriority: number;
  connectionStatus?: string;
}

export interface CreateWebsitePlatformDto {
  name: string;
  slug: string;
  logoUrl?: string;
  description?: string;
  category: 'ecommerce' | 'marketplace' | 'cms' | 'erp' | 'pos' | 'custom_website';
  authType: 'oauth2' | 'api_key' | 'bearer_token' | 'jwt' | 'username_password' | 'webhook' | 'custom' | 'none';
  apiBaseUrl?: string;
  oauthUrl?: string;
  tokenUrl?: string;
  redirectUrl?: string;
  scopes?: string[];
  requiredFields?: WebsitePlatformField[];
  webhookSecret?: string;
  apiVersion?: string;
  healthEndpoint?: string;
  documentationUrl?: string;
  supportedFeatures?: Record<string, boolean>;
  connectionWizard?: Record<string, unknown>;
  enabled?: boolean;
  maintenanceMode?: boolean;
  isDefault?: boolean;
  priority?: number;
  fallbackPriority?: number;
}

export interface UserPlatformConnection {
  id: string;
  tenantId: string;
  userId?: string;
  platformId: string;
  platformSlug: string;
  platformName: string;
  accountLabel?: string | null;
  connectionStatus: string;
  isActive: boolean;
  lastValidatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const websitePlatforms = {
  available: () => request<WebsitePlatform[]>('/website-platforms/available'),
};

export const userWebsiteConnections = {
  list: () => request<UserPlatformConnection[]>('/user/business-connections/website'),
  connect: (dto: { platformSlug: string; accountLabel?: string; credentials?: Record<string, string>; metadata?: Record<string, unknown> }) =>
    request<UserPlatformConnection>('/user/business-connections/website/connect', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  rotate: (connectionId: string, dto: { credentials: Record<string, string>; reason?: string }) =>
    request<{ message: string; connection: UserPlatformConnection }>(`/user/business-connections/website/${connectionId}/rotate`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  disconnect: (connectionId: string) =>
    request<{ message: string }>(`/user/business-connections/website/${connectionId}`, { method: 'DELETE' }),
  startOAuth: (dto: { platformSlug: string; redirectUri: string }) =>
    request<{ authorizationUrl: string; state: string }>('/user/business-connections/website/oauth/start', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  completeOAuth: (dto: { platformSlug: string; state: string; redirectUri: string; code: string; refreshToken?: string }) =>
    request<{ ok: true; platformSlug: string }>('/user/business-connections/website/oauth/callback', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
};

// â”€â”€ AI Providers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AiProvider {
  id: string;
  providerKey: string;
  displayName: string;
  category: string;
  description?: string | null;
  logoUrl?: string | null;
  providerType?: string | null;
  docsUrl?: string | null;
  baseUrl?: string | null;
  apiBaseUrl?: string | null;
  supportedModels?: string[];
  defaultModel?: string | null;
  capabilities?: Record<string, unknown>;
  features?: Record<string, boolean>;
  pricingUnit?: string | null;
  pricingPerUnit?: number | null;
  priority?: number;
  fallbackPriority?: number;
  enabled?: boolean;
  byokEnabled?: boolean;
  healthStatus?: string;
  status?: string;
  apiKeyConfigured?: boolean;
  requestsPerMinute?: number;
  requestsPerDay?: number;
  dailyRequestLimit?: number | null;
  monthlyRequestLimit?: number | null;
  authType?: 'bearer' | 'x-api-key' | 'query-param' | 'none';
  queryParamName?: string | null;
  isDefault?: boolean;
}

export interface CreateAiProviderDto {
  providerKey: string;
  displayName: string;
  category: string;
  providerType?: string;
  logoUrl?: string;
  description?: string;
  apiBaseUrl?: string;
  baseUrl?: string;
  apiKey?: string;
  organizationId?: string;
  supportedModels?: string[];
  modelList?: string[];
  defaultModel?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  retryCount?: number;
  costPer1KTokens?: number;
  dailyBudget?: number;
  monthlyBudget?: number;
  requestsPerMinute?: number;
  requestsPerDay?: number;
  dailyRequestLimit?: number;
  monthlyRequestLimit?: number;
  authType?: 'bearer' | 'x-api-key' | 'query-param' | 'none';
  queryParamName?: string;
  isDefault?: boolean;
  healthCheckUrl?: string;
  endpointPath?: string;
  authHeaderName?: string;
  authHeaderTemplate?: string;
  priority?: number;
  fallbackPriority?: number;
  enabled?: boolean;
  byokEnabled?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsImageGeneration?: boolean;
  supportsFunctionCalling?: boolean;
  supportsJsonMode?: boolean;
  requestTemplate?: Record<string, unknown>;
  responseMapping?: Record<string, unknown>;
}

export interface UserAiConnection {
  id: string;
  providerId: string;
  providerKey: string;
  providerDisplayName?: string;
  connectionStatus: string;
  isActive: boolean;
  allowPlatformFallback: boolean;
  quotaLimit: number | null;
  quotaUsed: number;
  totalRequests: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface UserAiProviderPreference {
  category: string;
  providerId: string;
  providerKey: string;
  providerDisplayName: string;
  model: string | null;
  useByok: boolean;
}

export const aiProviders = {
  available: () => request<AiProvider[]>('/ai-providers/available'),
};

export const userAiConnections = {
  list: () => request<UserAiConnection[]>('/user/ai-connections'),
  connect: (providerId: string, apiKey: string, secondaryKey?: string, quotaLimit?: number) =>
    request<UserAiConnection>('/user/ai-connections/connect', {
      method: 'POST',
      body: JSON.stringify({ providerId, apiKey, secondaryKey, quotaLimit }),
    }),
  disconnect: (connectionId: string) =>
    request<void>(`/user/ai-connections/${connectionId}`, { method: 'DELETE' }),
  healthCheck: (connectionId: string) =>
    request<{ status: string; latencyMs: number | null; error?: string }>(
      `/user/ai-connections/${connectionId}/health-check`,
      { method: 'POST' },
    ),
  analytics: () => request<unknown>('/user/ai-connections/analytics'),
  preferences: () => request<UserAiProviderPreference[]>('/user/ai-connections/preferences'),
  setPreference: (category: string, providerId: string, model?: string, useByok = false) =>
    request<UserAiProviderPreference>('/user/ai-connections/preferences', {
      method: 'POST',
      body: JSON.stringify({ category, providerId, model, useByok }),
    }),
};

// ── Returns (V64 Return Shield) ───────────────────────────────────────────────

export interface ReturnRequest {
  id: string;
  orderId: string;
  productId: string | null;
  reason: string;
  notes: string | null;
  status: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH_RISK_RETURN';
  currency: string;
  estimatedRefundExposure: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitReturnDto {
  orderId: string;
  productId?: string;
  reason: string;
  notes?: string;
}

export interface AdminReturnAction {
  action: 'APPROVE' | 'REJECT' | 'FREEZE' | 'CLOSE' | 'NOTE' | 'STATUS_CHANGED' | 'MORE_INFO_REQUESTED';
  adminNotes?: string;
  rejectionReason?: string;
}

export interface TriggerRefundDto {
  confirmationPhrase: 'CONFIRM_REFUND';
}

export const returns = {
  submit: (dto: SubmitReturnDto) =>
    request<ReturnRequest>('/returns', { method: 'POST', body: JSON.stringify(dto) }),
  list: (page = 1, limit = 20) =>
    request<{ data: ReturnRequest[]; total: number }>(`/returns?page=${page}&limit=${limit}`),
  get: (id: string) =>
    request<ReturnRequest>(`/returns/${id}`),
  uploadEvidence: (id: string, formData: FormData) =>
    request<unknown>(`/returns/${id}/evidence`, {
      method: 'POST',
      body: formData,
    }),
  listEvidence: (id: string) =>
    request<unknown[]>(`/returns/${id}/evidence`),
};

export const adminReturns = {
  queue: (status?: string, page = 1, limit = 50) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) params.set('status', status);
    return request<unknown>(`/admin/returns?${params}`);
  },
  stats: () => request<unknown>('/admin/returns/stats'),
  auditExport: () => request<unknown>('/admin/returns/audit/export'),
  get: (id: string) => request<unknown>(`/admin/returns/${id}`),
  action: (id: string, dto: AdminReturnAction) =>
    request<unknown>(`/admin/returns/${id}/action`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  triggerRefund: (id: string, dto: TriggerRefundDto) =>
    request<unknown>(`/admin/returns/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  getEvidence: (id: string) => request<unknown[]>(`/admin/returns/${id}/evidence`),
  uploadEvidence: (id: string, formData: FormData) =>
    request<unknown>(`/admin/returns/${id}/evidence`, {
      method: 'POST',
      body: formData,
    }),
  getAuditTrail: (id: string) => request<unknown[]>(`/admin/returns/${id}/audit`),
  fraudAnalysis: (id: string) => request<unknown>(`/admin/returns/${id}/fraud-analysis`),
};

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  subscriptionTier: string;
  isActive: boolean;
  createdAt: string;
}

export const adminApi = {
  users: (page = 1, limit = 50) =>
    request<Paginated<AdminUser>>(`/admin/users?page=${page}&limit=${limit}`),
  updateUser: (id: string, dto: Partial<Pick<AdminUser, 'role' | 'subscriptionTier' | 'isActive'>>) =>
    request<AdminUser>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  systemStats: () => request<unknown>('/admin/system/stats'),
  aiProviders: () => request<AiProvider[]>('/admin/ai-providers'),
  aiProviderPresets: () => request<CreateAiProviderDto[]>('/admin/ai-providers/presets'),
  aiProviderAnalytics: (days = 30) => request<unknown>(`/admin/ai-providers/analytics?days=${days}`),
  websitePlatforms: () => request<WebsitePlatform[]>('/admin/website-platforms'),
  websitePlatformPresets: () => request<Array<CreateWebsitePlatformDto & { presetKey?: string }>>('/admin/website-platforms/presets'),
  websitePlatformAnalytics: (days = 30) => request<unknown[]>(`/admin/website-platforms/analytics?days=${days}`),
  createWebsitePlatform: (dto: CreateWebsitePlatformDto) =>
    request<WebsitePlatform>('/admin/website-platforms', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateWebsitePlatform: (id: string, dto: Partial<CreateWebsitePlatformDto>) =>
    request<WebsitePlatform>(`/admin/website-platforms/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteWebsitePlatform: (id: string) =>
    request<void>(`/admin/website-platforms/${id}`, { method: 'DELETE' }),
  testWebsitePlatform: (id: string) =>
    request<{ status: string; latencyMs: number | null; error?: string }>(
      `/admin/website-platforms/${id}/test`,
      { method: 'POST' },
    ),
  createAiProvider: (dto: CreateAiProviderDto) =>
    request<AiProvider>('/admin/ai-providers', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateAiProvider: (id: string, dto: Partial<CreateAiProviderDto>) =>
    request<AiProvider>(`/admin/ai-providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  approveAiProvider: (id: string) =>
    request<AiProvider>(`/admin/ai-providers/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ notes: 'Enabled from admin AI Providers panel' }),
    }),
  disableAiProvider: (id: string, reason: string) =>
    request<{ message: string; providerId: string }>(`/admin/ai-providers/${id}/disable`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  deleteAiProvider: (id: string) =>
    request<{ message: string; providerId: string }>(`/admin/ai-providers/${id}`, {
      method: 'DELETE',
    }),
  testAiProvider: (id: string) =>
    request<{ status: string; latencyMs: number | null; error?: string }>(
      `/admin/ai-providers/${id}/test`,
      { method: 'POST' },
    ),
  setDefaultAiProvider: (id: string) =>
    request<AiProvider>(`/admin/ai-providers/${id}/default`, {
      method: 'POST',
    }),
  exportAiProviders: () => request<{ exportedAt: string; providers: AiProvider[] }>('/admin/ai-providers/export'),
  importAiProviders: (providers: CreateAiProviderDto[]) =>
    request<{ imported: number; skipped: number }>('/admin/ai-providers/import', {
      method: 'POST',
      body: JSON.stringify({ providers }),
    }),
};
