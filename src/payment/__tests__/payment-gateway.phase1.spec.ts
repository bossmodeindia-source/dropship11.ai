import { createHmac } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayService } from '../payment-gateway.service';

describe('payment-gateway.service phase1 coverage', () => {
  const config = (values: Record<string, string>) => ({
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('creates Razorpay prepaid orders with admin credentials and tenant notes', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ id: 'order_123' }),
    } as any);
    const service = new PaymentGatewayService(config({
      RAZORPAY_KEY_ID: 'key_id',
      RAZORPAY_KEY_SECRET: 'key_secret',
      PAYMENT_GATEWAY: 'razorpay',
    }) as any);

    const order = await service.createOrder({
      amount: 12345,
      currency: 'INR',
      receipt: 'platform-order-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      notes: { source: 'checkout' },
    });

    expect(order).toEqual({ provider: 'razorpay', gatewayOrderId: 'order_123', amount: 12345, currency: 'INR', receipt: 'platform-order-1' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.razorpay.com/v1/orders', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from('key_id:key_secret').toString('base64')}` }),
      body: expect.stringContaining('"tenant_id":"tenant-1"'),
    }));
    expect(fetchMock.mock.calls[0][1]?.body as string).not.toContain('cod');
  });

  it('rejects missing Razorpay credentials before making an external API call', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as any);
    const service = new PaymentGatewayService(config({ PAYMENT_GATEWAY: 'razorpay' }) as any);

    await expect(service.createOrder({ amount: 100, currency: 'INR', receipt: 'r1', tenantId: 't1' })).rejects.toThrow('RAZORPAY_KEY_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies Razorpay HMAC signatures using timing-safe comparison', () => {
    const secret = 'key_secret';
    const service = new PaymentGatewayService(config({ RAZORPAY_KEY_SECRET: secret }) as any);
    const validSignature = createHmac('sha256', secret).update('order_1|pay_1').digest('hex');

    expect(service.verifyPayment({ provider: 'razorpay', gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1', signature: validSignature })).toBe(true);
    expect(service.verifyPayment({ provider: 'razorpay', gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1', signature: 'abcd' })).toBe(false);
    expect(service.verifyPayment({ provider: 'stripe', gatewayOrderId: 'pi_1', gatewayPaymentId: 'pi_1', signature: 'stripe_confirmed' })).toBe(true);
    expect(service.verifyPayment({ provider: 'stripe', gatewayOrderId: 'pi_1', gatewayPaymentId: 'pi_1', signature: 'bad' })).toBe(false);
  });

  it('creates Stripe payment intents and refunds through mocked HTTP calls', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ id: 'pi_123', client_secret: 'secret_123' }) } as any)
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ id: 're_123', currency: 'usd', status: 'succeeded' }) } as any);
    const service = new PaymentGatewayService(config({ STRIPE_SECRET_KEY: 'sk_test', PAYMENT_GATEWAY: 'stripe' }) as any);

    await expect(service.createOrder({ amount: 5000, currency: 'USD', receipt: 'r2', tenantId: 't2', provider: 'stripe' })).resolves.toEqual(expect.objectContaining({
      provider: 'stripe',
      gatewayOrderId: 'pi_123',
      clientSecret: 'secret_123',
    }));
    await expect(service.issueRefund({ provider: 'stripe', gatewayPaymentId: 'pi_123', amount: 1200, reason: 'customer request' })).resolves.toEqual({
      refundId: 're_123',
      provider: 'stripe',
      amount: 1200,
      currency: 'USD',
      status: 'succeeded',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.stripe.com/v1/payment_intents');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.stripe.com/v1/refunds');
  });

  it('throws for unknown providers and converts currencies to smallest units', async () => {
    const service = new PaymentGatewayService(config({ PAYMENT_GATEWAY: 'razorpay' }) as any);

    await expect(service.createOrder({ amount: 1, currency: 'INR', receipt: 'r', tenantId: 't', provider: 'paypal' as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.issueRefund({ provider: 'paypal' as any, gatewayPaymentId: 'p', amount: 1, reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(PaymentGatewayService.toSmallestUnit(10.235, 'INR')).toBe(1024);
    expect(PaymentGatewayService.toSmallestUnit(10.6, 'JPY')).toBe(11);
  });
});
