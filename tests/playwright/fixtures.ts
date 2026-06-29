import { expect, Page, Route, test as base } from '@playwright/test';

type Role = 'user' | 'admin';

type ApiCall = {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body?: unknown;
};

type MockOptions = {
  role?: Role;
  invalidLoginMessage?: string;
  invalidLoginStatus?: number;
};

type MockContext = {
  calls: ApiCall[];
  setRole: (role: Role) => void;
  nextFailure: (pathname: string, status: number, message: string) => void;
  assertCalled: (method: string, pathname: string) => void;
};

export const test = base.extend<{ api: MockContext }>({
  api: [
    async ({ page }, use) => {
    const context = await mockCommerceApi(page);
    await use(context);
    },
    { auto: true },
  ],
});

export { expect };

const userProfile = {
  id: 'user-1',
  email: 'user@example.com',
  fullName: 'Ava Merchant',
  role: 'user',
  subscriptionTier: 'pro',
};

const adminProfile = {
  id: 'admin-1',
  email: 'admin@example.com',
  fullName: 'Ada Admin',
  role: 'admin',
  subscriptionTier: 'enterprise',
};

export async function mockCommerceApi(page: Page, options: MockOptions = {}): Promise<MockContext> {
  const calls: ApiCall[] = [];
  const failures = new Map<string, { status: number; message: string }>();
  let role: Role = options.role ?? 'user';

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api\/v1/, '');
    const method = request.method().toUpperCase();
    const headers = request.headers();
    const body = parseBody(request.postData());
    calls.push({ method, pathname, headers, body });

    const failure = failures.get(pathname);
    if (failure) {
      failures.delete(pathname);
      return json(route, failure.status, { message: failure.message });
    }

    if (pathname !== '/auth/login' && pathname !== '/auth/register' && pathname !== '/auth/refresh') {
      const bearer = headers.authorization;
      if (!bearer?.startsWith('Bearer ')) {
        return json(route, 401, { message: 'Unauthorized' });
      }
    }

    if (headers['x-tenant-id'] === 'tenant-b') {
      return json(route, 403, { message: 'Tenant isolation violation blocked' });
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && headers['x-require-csrf'] === 'true' && !headers['x-csrf-token']) {
      return json(route, 403, { message: 'CSRF token required' });
    }

    if (pathname === '/auth/login' && method === 'POST') {
      const credentials = body as { email?: string; password?: string };
      if (credentials.email === 'user@example.com' && credentials.password === 'Password1!') {
        role = 'user';
        return json(route, 200, tokens(userProfile));
      }
      if (credentials.email === 'admin@example.com' && credentials.password === 'Password1!') {
        role = 'admin';
        return json(route, 200, tokens(adminProfile));
      }
      return json(route, options.invalidLoginStatus ?? 401, { message: options.invalidLoginMessage ?? 'Invalid credentials' });
    }

    if (pathname === '/auth/register' && method === 'POST') {
      return json(route, 201, tokens(userProfile));
    }

    if (pathname === '/auth/logout' && method === 'POST') {
      return json(route, 204);
    }

    if (pathname === '/auth/refresh' && method === 'POST') {
      return json(route, 200, { accessToken: 'access-token-refreshed', refreshToken: 'refresh-token-refreshed' });
    }

    if (pathname === '/auth/me' && method === 'GET') {
      return json(route, 200, role === 'admin' ? adminProfile : userProfile);
    }

    if (pathname === '/dashboard/summary' && method === 'GET') {
      return json(route, 200, { revenueToday: 18450, activeOrders: 12, productsListed: 48, roas: 3.42, currency: 'INR' });
    }

    if (pathname === '/admin/users' && method === 'GET') {
      return json(route, 200, {
        data: [
          { id: 'user-1', email: 'user@example.com', fullName: 'Ava Merchant', role: 'user', subscriptionTier: 'pro', isActive: true, createdAt: '2026-06-01T00:00:00.000Z' },
          { id: 'admin-1', email: 'admin@example.com', fullName: 'Ada Admin', role: 'admin', subscriptionTier: 'enterprise', isActive: true, createdAt: '2026-06-02T00:00:00.000Z' },
        ],
        total: 2,
        page: 1,
        limit: 50,
      });
    }

    if (pathname === '/users/profile' && method === 'PATCH') {
      return json(route, 200, { ...userProfile, ...(body as object) });
    }

    if (pathname === '/integrations/status' && method === 'GET') {
      return json(route, 200, [
        { platform: 'shopify', connected: true, shopName: 'ai-empire.myshopify.com', lastSync: '2026-06-27T07:00:00.000Z' },
        { platform: 'meta', connected: false },
      ]);
    }

    if (pathname === '/shopify/connect' && method === 'POST') {
      const payload = body as { apiKey?: string; shop?: string };
      if (payload.apiKey === 'bad-key') {
        return json(route, 401, { message: 'Invalid Shopify credentials' });
      }
      return json(route, 201, { connected: true, shop: payload.shop ?? 'ai-empire.myshopify.com' });
    }

    if (pathname === '/shopify/disconnect' && method === 'POST') {
      return json(route, 200, { connected: false });
    }

    if (pathname === '/campaigns' && method === 'GET') {
      return json(route, 200, {
        data: [
          { id: 'camp-1', name: 'Summer Scale', platform: 'meta', status: 'active', budget: 2500, spent: 410, roas: 3.8, currency: 'INR', createdAt: '2026-06-01T00:00:00.000Z' },
          { id: 'camp-2', name: 'Retarget Winners', platform: 'google', status: 'paused', budget: 1200, spent: 210, roas: 2.9, currency: 'INR', createdAt: '2026-06-03T00:00:00.000Z' },
        ],
        total: 2,
        page: 1,
        limit: 20,
      });
    }

    if (pathname === '/campaigns' && method === 'POST') {
      return json(route, 201, { id: 'camp-new', ...(body as object), status: 'draft' });
    }

    if (pathname === '/campaigns/camp-new' && method === 'PATCH') {
      return json(route, 200, { id: 'camp-new', ...(body as object) });
    }

    if (pathname === '/campaigns/camp-new/pause' && method === 'POST') {
      return json(route, 200, { id: 'camp-new', status: 'paused' });
    }

    if (pathname === '/campaigns/camp-new' && method === 'DELETE') {
      return json(route, 204);
    }

    if (pathname === '/orders' && method === 'GET') {
      return json(route, 200, {
        data: [
          { id: 'order-1', shopifyOrderId: 'AE-1001', customerEmail: 'buyer@example.com', totalPrice: 2199, currency: 'INR', status: 'processing', createdAt: '2026-06-27T07:00:00.000Z' },
        ],
        total: 1,
        page: 1,
        limit: 20,
      });
    }

    if (pathname === '/orders' && method === 'POST') {
      return json(route, 201, { id: 'order-new', status: 'created', ...(body as object) });
    }

    if (pathname === '/webhooks/shopify/orders' && method === 'POST') {
      return json(route, 202, { processed: true, idempotencyKey: headers['idempotency-key'] ?? 'missing' });
    }

    if (pathname === '/escrow/transactions' && method === 'POST') {
      return json(route, 201, { id: 'escrow-1', status: 'held', amount: 2199 });
    }

    if (pathname === '/supplier-routing/route' && method === 'POST') {
      return json(route, 200, { supplierId: 'supplier-1', route: 'primary', etaDays: 4 });
    }

    if (pathname === '/orders/order-new/tracking' && method === 'PATCH') {
      return json(route, 200, { id: 'order-new', fulfillmentStatus: 'shipped', trackingNumber: 'TRK123' });
    }

    if (pathname === '/withdrawals' && method === 'POST') {
      return json(route, 201, { id: 'withdrawal-1', status: 'pending', amount: 1000 });
    }

    if (pathname === '/withdrawals/withdrawal-1/approve' && method === 'POST') {
      return json(route, 200, { id: 'withdrawal-1', status: 'approved' });
    }

    if (pathname === '/withdrawals/withdrawal-2/reject' && method === 'POST') {
      return json(route, 200, { id: 'withdrawal-2', status: 'rejected', reason: 'Risk review failed' });
    }

    if (pathname === '/payments/charge' && method === 'POST') {
      return json(route, 201, { id: 'payment-1', status: 'captured' });
    }

    if (pathname === '/products' && method === 'GET') {
      return json(route, 200, {
        data: [
          { id: 'prod-1', title: 'AI Winner Lamp', price: 1499, status: 'active', score: 92, createdAt: '2026-06-01T00:00:00.000Z' },
        ],
        total: 1,
        page: 1,
        limit: 20,
      });
    }

    if (pathname === '/analytics/snapshot' && method === 'GET') {
      return json(route, 200, { revenue: 84000, spend: 22000, roas: 3.82, orders: 64, conversionRate: 4.7 });
    }

    return json(route, 404, { message: `Unhandled mock route: ${method} ${pathname}` });
  });

  return {
    calls,
    setRole(nextRole) {
      role = nextRole;
    },
    nextFailure(pathname, status, message) {
      failures.set(pathname, { status, message });
    },
    assertCalled(method, pathname) {
      expect(calls.some((call) => call.method === method && call.pathname === pathname)).toBeTruthy();
    },
  };
}

export async function loginViaUi(page: Page, email = 'user@example.com') {
  await page.goto('/');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.locator('input[type="password"]').fill('Password1!');
  await page.getByRole('button', { name: 'Sign In' }).last().click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/Welcome back/)).toBeVisible();
}

export async function seedSession(page: Page, role: Role = 'user') {
  const profile = role === 'admin' ? adminProfile : userProfile;
  await page.addInitScript((session) => {
    window.localStorage.setItem('access_token', session.accessToken);
    window.localStorage.setItem('refresh_token', session.refreshToken);
  }, tokens(profile));
}

export async function browserApi<T = unknown>(page: Page, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ path: targetPath, init: requestInit }) => {
      const response = await fetch(`/api/v1${targetPath}`, {
        ...requestInit,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${window.localStorage.getItem('access_token') ?? 'access-token'}`,
          ...(requestInit.headers as Record<string, string> | undefined),
        },
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
      };
    },
    { path, init },
  ) as Promise<{ status: number; body: T }>;
}

function tokens(user: object) {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    user,
  };
}

function parseBody(postData: string | null): unknown {
  if (!postData) return undefined;
  try {
    return JSON.parse(postData);
  } catch {
    return postData;
  }
}

async function json(route: Route, status: number, body?: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: body === undefined ? '' : JSON.stringify(body),
  });
}
