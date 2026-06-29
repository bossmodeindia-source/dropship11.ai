import { ForbiddenException } from '@nestjs/common';
import { CommissionService } from '../../commission/commission.service';
import { SupplierPaymentService } from '../../supplier-payment/supplier-payment.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { EscrowTransactionService } from '../../escrow/escrow-transaction.service';

const tenantId = 'tenant-commerce-1';
const orderId = 'order-commerce-1';

function makeInsertDb(returningRow: Record<string, unknown>) {
  return {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([returningRow]),
      }),
    }),
  };
}

describe('Commerce pipeline integration contracts', () => {
  it('computes a hidden commission floor and exposes only user-safe price info', async () => {
    const db: any = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{
            isEnabled: true,
            commissionType: 'percentage',
            fixedAmount: '0',
            percentage: '20',
            appliedToCategory: null,
          }]),
        }),
      }),
    };
    const commission = new CommissionService(db);

    await expect(commission.computePriceFloor(500, 'INR')).resolves.toEqual({
      supplierPrice: 500,
      commissionAmount: 100,
      minimumAllowedPrice: 600,
      currency: 'INR',
    });
    await expect(commission.getUserPriceInfo(500, 'INR')).resolves.toEqual({
      minimumAllowedPrice: 600,
      currency: 'INR',
    });
  });

  it('creates supplier payment records using current DTOs and hides internal amounts from users', async () => {
    const db: any = makeInsertDb({
      id: 'supplier-payment-1',
      orderId,
      tenantId,
      userId: 'user-1',
      amount: '600',
      amountDue: '500',
      currency: 'INR',
      status: 'pending',
      paidAt: null,
      notes: JSON.stringify({ supplierBasePrice: 500, commissionAmount: 100 }),
    });
    const commission = {
      computePriceFloor: jest.fn().mockResolvedValue({
        supplierPrice: 500,
        commissionAmount: 100,
        minimumAllowedPrice: 600,
        currency: 'INR',
      }),
    };
    const service = new SupplierPaymentService(
      db,
      commission as never,
      { log: jest.fn() } as never,
      { sendCritical: jest.fn() } as never,
    );

    const result = await service.createForOrder({
      orderId,
      tenantId,
      userId: 'user-1',
      rawSupplierPrice: 500,
      currency: 'INR',
      productCategory: 'electronics',
    });

    expect(result).toEqual({
      id: 'supplier-payment-1',
      orderId,
      amountToPay: 600,
      currency: 'INR',
      status: 'pending',
      paidAt: null,
    });
    expect(result).not.toHaveProperty('supplierAmount');
    expect(result).not.toHaveProperty('commissionAmount');
  });

  it('blocks fulfillment when the current supplier payment contract is unpaid', async () => {
    const alerting = { sendCritical: jest.fn() };
    const db: any = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ status: 'initiated' }]),
          }),
        }),
      }),
    };
    const service = new SupplierPaymentService(
      db,
      { computePriceFloor: jest.fn() } as never,
      { log: jest.fn() } as never,
      alerting as never,
    );

    await expect(service.assertSupplierPaid(orderId, tenantId)).rejects.toThrow(ForbiddenException);
    expect(alerting.sendCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Fulfillment Blocked'),
      }),
    );
  });

  it('writes business changes and outbox event in the same transaction via writeWithOutbox', async () => {
    const tx = makeInsertDb({ id: 'outbox-event-1' });
    const db: any = {
      transaction: jest.fn(async (fn: (txArg: unknown) => Promise<unknown>) => fn(tx)),
    };
    const outbox = new OutboxService(
      db,
      { xadd: jest.fn() } as never,
      { sendCritical: jest.fn() } as never,
    );

    const result = await outbox.writeWithOutbox(
      async (txArg) => {
        expect(txArg).toBe(tx);
        return { orderId, status: 'ORDER_PAID' };
      },
      {
        eventType: 'ORDER_PAID',
        tenantId,
        aggregateId: orderId,
        aggregateType: 'order',
        payload: { orderId },
      },
    );

    expect(result).toEqual({ orderId, status: 'ORDER_PAID' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalled();
  });

  it('uses current escrow fee math for payment-to-profit accounting', () => {
    expect(EscrowTransactionService.calculateFees(1000)).toEqual({
      razorpayFee: 23,
      netAfterGateway: 977,
    });
  });
});
