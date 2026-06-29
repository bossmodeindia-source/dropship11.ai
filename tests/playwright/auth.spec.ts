import { expect, loginViaUi, mockCommerceApi, seedSession, test } from './fixtures';

test.describe('authentication', () => {
  test('logs in with valid credentials and persists the session', async ({ page }) => {
    await loginViaUi(page);
    await page.reload();

    await expect(page.getByText(/Welcome back, Ava/)).toBeVisible();
    await expect(page.getByText(/Plan:/)).toBeVisible();
  });

  test('shows invalid credential errors without storing a session', async ({ page }) => {
    await page.unroute('**/api/v1/**').catch(() => undefined);
    await mockCommerceApi(page, {
      invalidLoginMessage: '<img src=x onerror=window.__xss=true> Invalid credentials',
      invalidLoginStatus: 400,
    });

    await page.goto('/');
    await page.getByPlaceholder('you@example.com').fill('bad@example.com');
    await page.locator('input[type="password"]').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign In' }).last().click();

    await expect(page.getByText(/Invalid credentials/)).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.evaluate(() => window.localStorage.getItem('access_token'))).resolves.toBeNull();
  });

  test('logs out and protects the dashboard route', async ({ page }) => {
    await loginViaUi(page);
    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/$/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/$/);
  });

  test('allows existing sessions to open dashboard directly', async ({ page }) => {
    await seedSession(page);
    await page.goto('/dashboard');

    await expect(page.getByText(/Welcome back, Ava/)).toBeVisible();
    await expect(page.getByText('Revenue Today')).toBeVisible();
  });
});
