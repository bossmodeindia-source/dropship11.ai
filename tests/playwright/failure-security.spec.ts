import { browserApi, expect, seedSession, test } from './fixtures';

test.describe('failure scenarios and security controls', () => {
  test('surfaces Redis, supplier, and payment outages and then retries successfully', async ({ page, api }) => {
    await seedSession(page);
    const initialSummary = page.waitForResponse((response) =>
      response.url().includes('/api/v1/dashboard/summary'),
    );
    await page.goto('/dashboard');
    await initialSummary;
    await expect(page.getByText(/Welcome back, Ava/)).toBeVisible();

    api.nextFailure('/dashboard/summary', 503, 'Redis unavailable');
    const redis = await browserApi<{ message: string }>(page, '/dashboard/summary');
    expect(redis.status).toBe(503);
    expect(redis.body.message).toContain('Redis unavailable');

    api.nextFailure('/supplier-routing/route', 503, 'Supplier unavailable');
    const supplierDown = await browserApi<{ message: string }>(page, '/supplier-routing/route', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-new' }),
    });
    const supplierRetry = await browserApi<{ supplierId: string }>(page, '/supplier-routing/route', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-new' }),
    });

    api.nextFailure('/payments/charge', 503, 'Payment unavailable');
    const paymentDown = await browserApi<{ message: string }>(page, '/payments/charge', {
      method: 'POST',
      body: JSON.stringify({ amount: 2199 }),
    });
    const paymentRetry = await browserApi<{ status: string }>(page, '/payments/charge', {
      method: 'POST',
      body: JSON.stringify({ amount: 2199 }),
    });

    expect(supplierDown.status).toBe(503);
    expect(supplierRetry.status).toBe(200);
    expect(supplierRetry.body.supplierId).toBe('supplier-1');
    expect(paymentDown.status).toBe(503);
    expect(paymentRetry.status).toBe(201);
    expect(paymentRetry.body.status).toBe('captured');
  });

  test('redirects unauthorized dashboard access to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Sign In' }).last()).toBeVisible();
  });

  test('enforces tenant isolation for browser-origin requests', async ({ page }) => {
    await seedSession(page);
    await page.goto('/dashboard');

    const response = await browserApi<{ message: string }>(page, '/orders', {
      headers: { 'x-tenant-id': 'tenant-b' },
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toContain('Tenant isolation');
  });

  test('rejects unsafe state changes without CSRF proof when required', async ({ page }) => {
    await seedSession(page);
    await page.goto('/dashboard');

    const rejected = await browserApi<{ message: string }>(page, '/orders', {
      method: 'POST',
      headers: { 'x-require-csrf': 'true' },
      body: JSON.stringify({ sku: 'SKU-1' }),
    });
    const accepted = await browserApi<{ id: string }>(page, '/orders', {
      method: 'POST',
      headers: { 'x-require-csrf': 'true', 'x-csrf-token': 'csrf-proof' },
      body: JSON.stringify({ sku: 'SKU-1' }),
    });

    expect(rejected.status).toBe(403);
    expect(rejected.body.message).toContain('CSRF token required');
    expect(accepted.status).toBe(201);
    expect(accepted.body.id).toBe('order-new');
  });

  test('renders hostile error text as inert text instead of executable markup', async ({ page }) => {
    await page.unroute('**/api/v1/**').catch(() => undefined);
    await import('./fixtures').then(({ mockCommerceApi }) =>
      mockCommerceApi(page, {
        invalidLoginMessage: '<svg onload=window.__xss=true>Invalid credentials</svg>',
        invalidLoginStatus: 400,
      }),
    );

    await page.goto('/');
    await page.getByPlaceholder('you@example.com').fill('attacker@example.com');
    await page.locator('input[type="password"]').fill('bad-password');
    await page.getByRole('button', { name: 'Sign In' }).last().click();

    await expect(page.getByText(/Invalid credentials/)).toBeVisible();
    await expect(page.locator('svg[onload]')).toHaveCount(0);
    await expect(page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).resolves.toBeUndefined();
  });
});
