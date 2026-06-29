import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SupplierPaymentService } from '../../supplier-payment/supplier-payment.service';

const pendingPayment = {
  id: 'payment-1',
  orderId: 'order-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  amount: '550',
  amountDue: '500',
  currency: 'INR',
  status: 'pending',
  paidAt: null,
  notes: JSON.stringify({ supplierBasePrice: 500, commissionAmount: 50 }),
};

function makeDb() {
  return {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([pendingPayment]),
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
}

describe('SupplierPaymentService current contract', () => {
  let db: ReturnType<typeof makeDb>;
  let service: SupplierPaymentService;
  let audit: { log: jest.Mock };
  let alerting: { sendCritical: jest.Mock };

  beforeEach(() => {
    db = makeDb();
    audit = { log: jest.fn() };
    alerting = { sendCritical: jest.fn().mockResolvedValue(undefined) };
    service = new SupplierPaymentService(
      db as any,
      {
        computePriceFloor: jest.fn().mockResolvedValue({
          supplierPrice: 500,
          commissionAmount: 50,
          minimumAllowedPrice: 550,
          currency: 'INR',
        }),
      } as any,
      audit as any,
      alerting as any,
    );
  });

  it('creates a user-safe supplier payment for an order', async () => {
    const result = await service.createForOrder({
      orderId: 'order-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      rawSupplierPrice: 500,
      currency: 'INR',
    });

    expect(result).toEqual({
      id: 'payment-1',
      orderId: 'order-1',
      amountToPay: 550,
      currency: 'INR',
      status: 'pending',
      paidAt: null,
    });
    expect(result).not.toHaveProperty('supplierAmount');
    expect(result).not.toHaveProperty('commissionAmount');
  });

  it('initiates a pending payment and writes audit', async () => {
    db.limit.mockResolvedValueOnce([pendingPayment]);
    db.returning.mockResolvedValueOnce([{ ...pendingPayment, status: 'initiated' }]);

    await expect(service.initiatePayment('payment-1', 'user-1', 'tenant-1'))
      .resolves.toEqual(expect.objectContaining({ status: 'initiated' }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SUPPLIER_PAYMENT_INITIATED',
      resourceId: 'payment-1',
    }));
  });

  it('rejects initiatePayment for missing or non-pending records', async () => {
    db.limit.mockResolvedValueOnce([]);
    await expect(service.initiatePayment('missing', 'user-1', 'tenant-1'))
      .rejects.toBeInstanceOf(NotFoundException);

    db.limit.mockResolvedValueOnce([{ ...pendingPayment, status: 'paid' }]);
    await expect(service.initiatePayment('payment-1', 'user-1', 'tenant-1'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks fulfillment until supplier payment is marked paid', async () => {
    db.limit.mockResolvedValueOnce([{ status: 'initiated' }]);

    await expect(service.assertSupplierPaid('order-1', 'tenant-1'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(alerting.sendCritical).toHaveBeenCalled();
  });

  it('allows fulfillment when supplier payment is paid', async () => {
    db.limit.mockResolvedValueOnce([{ status: 'paid' }]);
    await expect(service.assertSupplierPaid('order-1', 'tenant-1')).resolves.toBeUndefined();
  });
});
