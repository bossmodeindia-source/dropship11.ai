import { browserApi, expect, seedSession, test } from './fixtures';

test.describe('commerce and withdrawal flows', () => {
  test('runs the browser-level commerce lifecycle', async ({ page, api }) => {
    await seedSession(page);
    await page.goto('/dashboard/orders');

    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await expect(page.getByText('AE-1001')).toBeVisible();

    const order = await browserApi<{ id: string; status: string }>(page, '/orders', {
      method: 'POST',
      body: JSON.stringify({ sku: 'SKU-1', quantity: 1, totalAmount: 2199 }),
    });
    const webhook = await browserApi<{ processed: boolean; idempotencyKey: string }>(page, '/webhooks/shopify/orders', {
      method: 'POST',
      headers: { 'idempotency-key': 'order-new-webhook-1' },
      body: JSON.stringify({ id: 'shopify-order-1', total_price: '2199.00' }),
    });
    const escrow = await browserApi<{ status: string }>(page, '/escrow/transactions', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-new', amount: 2199 }),
    });
    const supplier = await browserApi<{ supplierId: string }>(page, '/supplier-routing/route', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-new', sku: 'SKU-1' }),
    });
    const tracking = await browserApi<{ fulfillmentStatus: string; trackingNumber: string }>(page, '/orders/order-new/tracking', {
      method: 'PATCH',
      body: JSON.stringify({ trackingNumber: 'TRK123', carrier: 'BlueDart' }),
    });

    expect(order.status).toBe(201);
    expect(order.body.id).toBe('order-new');
    expect(webhook.body.processed).toBe(true);
    expect(webhook.body.idempotencyKey).toBe('order-new-webhook-1');
    expect(escrow.body.status).toBe('held');
    expect(supplier.body.supplierId).toBe('supplier-1');
    expect(tracking.body.fulfillmentStatus).toBe('shipped');
    expect(tracking.body.trackingNumber).toBe('TRK123');
    api.assertCalled('POST', '/orders');
    api.assertCalled('POST', '/webhooks/shopify/orders');
    api.assertCalled('POST', '/escrow/transactions');
    api.assertCalled('POST', '/supplier-routing/route');
    api.assertCalled('PATCH', '/orders/order-new/tracking');
  });

  test('covers withdrawal request, approval, and rejection paths', async ({ page, api }) => {
    await seedSession(page);
    await page.goto('/dashboard');

    const request = await browserApi<{ id: string; status: string }>(page, '/withdrawals', {
      method: 'POST',
      body: JSON.stringify({ amount: 1000, destination: 'bank-account-1' }),
    });
    const approval = await browserApi<{ status: string }>(page, '/withdrawals/withdrawal-1/approve', { method: 'POST' });
    const rejection = await browserApi<{ status: string; reason: string }>(page, '/withdrawals/withdrawal-2/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Risk review failed' }),
    });

    expect(request.status).toBe(201);
    expect(request.body.status).toBe('pending');
    expect(approval.body.status).toBe('approved');
    expect(rejection.body.status).toBe('rejected');
    expect(rejection.body.reason).toBe('Risk review failed');
    api.assertCalled('POST', '/withdrawals');
    api.assertCalled('POST', '/withdrawals/withdrawal-1/approve');
    api.assertCalled('POST', '/withdrawals/withdrawal-2/reject');
  });
});
