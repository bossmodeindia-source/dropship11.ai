import { browserApi, expect, seedSession, test } from './fixtures';

test.describe('shopify and campaign management', () => {
  test('shows Shopify integration state and validates connect/disconnect contracts', async ({ page, api }) => {
    await seedSession(page);
    await page.goto('/dashboard/integrations');

    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shopify' })).toBeVisible();
    await expect(page.getByText('ai-empire.myshopify.com')).toBeVisible();

    const connect = await browserApi<{ connected: boolean }>(page, '/shopify/connect', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'valid-key', shop: 'ai-empire.myshopify.com' }),
    });
    const disconnect = await browserApi<{ connected: boolean }>(page, '/shopify/disconnect', {
      method: 'POST',
      body: JSON.stringify({ shop: 'ai-empire.myshopify.com' }),
    });

    expect(connect.status).toBe(201);
    expect(connect.body.connected).toBe(true);
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.connected).toBe(false);
    api.assertCalled('POST', '/shopify/connect');
    api.assertCalled('POST', '/shopify/disconnect');
  });

  test('rejects invalid Shopify credentials', async ({ page }) => {
    await seedSession(page);
    await page.goto('/dashboard/integrations');

    const response = await browserApi<{ message: string }>(page, '/shopify/connect', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'bad-key', shop: 'bad.myshopify.com' }),
    });

    expect(response.status).toBe(401);
    expect(response.body.message).toContain('Invalid Shopify credentials');
  });

  test('loads campaigns and exercises create, edit, pause, and delete paths', async ({ page, api }) => {
    await seedSession(page);
    await page.goto('/dashboard/campaigns');

    await expect(page.getByText('AI Campaigns')).toBeVisible();
    await expect(page.getByText('Summer Scale')).toBeVisible();

    const created = await browserApi<{ id: string; status: string }>(page, '/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'Launch New Winner', platform: 'meta', budget: 3000 }),
    });
    const edited = await browserApi<{ budget: number }>(page, '/campaigns/camp-new', {
      method: 'PATCH',
      body: JSON.stringify({ budget: 4500 }),
    });
    const paused = await browserApi<{ status: string }>(page, '/campaigns/camp-new/pause', { method: 'POST' });
    const deleted = await browserApi(page, '/campaigns/camp-new', { method: 'DELETE' });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    expect(edited.body.budget).toBe(4500);
    expect(paused.body.status).toBe('paused');
    expect(deleted.status).toBe(204);
    api.assertCalled('POST', '/campaigns');
    api.assertCalled('PATCH', '/campaigns/camp-new');
    api.assertCalled('POST', '/campaigns/camp-new/pause');
    api.assertCalled('DELETE', '/campaigns/camp-new');
  });
});
