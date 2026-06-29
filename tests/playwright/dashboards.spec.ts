import { browserApi, expect, seedSession, test } from './fixtures';

test.describe('dashboards', () => {
  test('loads the user dashboard with metrics and subscription status', async ({ page }) => {
    await seedSession(page, 'user');
    await page.goto('/dashboard');

    await expect(page.getByText(/Welcome back, Ava/)).toBeVisible();
    await expect(page.getByText('Revenue Today')).toBeVisible();
    await expect(page.getByText('Active Orders')).toBeVisible();
    await expect(page.getByText('Products Listed')).toBeVisible();
    await expect(page.getByText('ROAS', { exact: true })).toBeVisible();
    await expect(page.getByText('pro', { exact: true })).toBeVisible();
  });

  test('loads the admin dashboard and user-management table', async ({ page, api }) => {
    api.setRole('admin');
    await seedSession(page, 'admin');
    await page.goto('/admin');

    await expect(page.getByText('Admin Panel')).toBeVisible();
    await expect(page.getByText('Total Users')).toBeVisible();
    await expect(page.getByText('System Health')).toBeVisible();
    await expect(page.getByText('Ava Merchant')).toBeVisible();
    await expect(page.getByText('admin@example.com')).toBeVisible();
  });

  test('updates a user profile through a browser-origin API contract', async ({ page }) => {
    await seedSession(page, 'user');
    await page.goto('/dashboard');

    const response = await browserApi<{ fullName: string }>(page, '/users/profile', {
      method: 'PATCH',
      body: JSON.stringify({ fullName: 'Ava Updated' }),
    });

    expect(response.status).toBe(200);
    expect(response.body.fullName).toBe('Ava Updated');
  });
});
