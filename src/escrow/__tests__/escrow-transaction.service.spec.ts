import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EscrowTransactionService, CreateEscrowInput } from '../escrow-transaction.service';
import { DomainEventType } from '../../common/events/domain-events';

function makeInput(overrides: Partial<CreateEscrowInput> = {}): CreateEscrowInput {
  return {
    tenantId: 'tenant-1',
    orderId: 'order-1',
    razorpayPaymentId: 'pay-1',
    razorpayOrderId: 'rp-order-1',
    customerPaidAmount: 1000,
    razorpayFee: 23,
    supplierProductCost: 400,
    supplierShippingCost: 50,
    taxAmount: 18,
    adminCommission: 100,
    currency: 'INR',
    ...overrides,
  };
}

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    razorpayPaymentId: 'pay-1',
    customerPaidAmount: '1000',
    razorpayFee: '23',
    supplierProductCost: '400',
    supplierShippingCost: '50',
    taxAmount: '18',
    adminCommission: '100',
    currency: 'INR',
    status: 'ESCROW_CREATED',
    paymentVerifiedAt: null,
    supplierPaidAt: null,
    deliveredAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeDb() {
  const tx = {
    execute: jest.fn().mockResolvedValue({ rows: [{ id: 'esc-1' }] }),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  };
  return {
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(),
    _tx: tx,
  };
}

describe('EscrowTransactionService', () => {
  let db: ReturnType<typeof makeDb>;
  let outbox: { publishInTx: jest.Mock };
  let alerting: { sendCritical: jest.Mock };
  let service: EscrowTransactionService;

  beforeEach(() => {
    db = makeDb();
    outbox = { publishInTx: jest.fn().mockResolvedValue('event-1') };
    alerting = { sendCritical: jest.fn().mockResolvedValue(undefined) };
    service = new EscrowTransactionService(
      db as any,
      { log: jest.fn() } as any,
      alerting as any,
      outbox as any,
    );
  });

  it('calculates gateway fees', () => {
    expect(EscrowTransactionService.calculateFees(1000)).toEqual({
      razorpayFee: 23,
      netAfterGateway: 977,
    });
  });

  it('creates escrow and emits ESCROW_CREATED in the same transaction', async () => {
    await expect(service.createEscrow(makeInput())).resolves.toEqual({
      escrowId: 'esc-1',
      created: true,
    });
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      db._tx,
      DomainEventType.ESCROW_CREATED,
      'tenant-1',
      expect.objectContaining({ orderId: 'order-1', userProfit: 409 }),
    );
  });

  it('returns existing escrow on duplicate payment without emitting a duplicate event', async () => {
    db._tx.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'esc-existing' }] });

    await expect(service.createEscrow(makeInput())).resolves.toEqual({
      escrowId: 'esc-existing',
      created: false,
    });
    expect(outbox.publishInTx).not.toHaveBeenCalled();
  });

  it('rejects invalid transitions and missing escrow rows', async () => {
    db.limit.mockResolvedValueOnce([makeEscrow({ status: 'SHIPPED' })]);
    await expect(service.advanceStatus('esc-1', 'ESCROW_CREATED', 'admin-1'))
      .rejects.toBeInstanceOf(BadRequestException);

    db.limit.mockResolvedValueOnce([]);
    await expect(service.advanceStatus('missing', 'SUPPLIER_PAID', 'admin-1'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('emits delivery and profit events on DELIVERED transition', async () => {
    db.limit.mockResolvedValueOnce([makeEscrow({ status: 'SHIPPED' })]);

    await service.advanceStatus('esc-1', 'DELIVERED', 'admin-1');

    expect(outbox.publishInTx).toHaveBeenCalledWith(
      db._tx,
      DomainEventType.ORDER_DELIVERED,
      'tenant-1',
      expect.objectContaining({ toStatus: 'DELIVERED' }),
    );
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      db._tx,
      DomainEventType.PROFIT_DISTRIBUTED,
      'tenant-1',
      expect.objectContaining({ userProfit: 409 }),
    );
  });

  it('does not expose admin commission in user view', async () => {
    db.limit.mockResolvedValueOnce([{
      id: 'esc-1',
      orderId: 'order-1',
      customerPaid: '1000',
      fee: '23',
      prodCost: '400',
      shipCost: '50',
      tax: '18',
      commission: '100',
      currency: 'INR',
      status: 'ESCROW_CREATED',
      deliveredAt: null,
    }]);
    const view = await service.getUserView('tenant-1', 'order-1');

    expect(view).toEqual(expect.objectContaining({ userProfit: 409 }));
    expect(view).not.toHaveProperty('adminCommission');
  });

  it('summarizes admin financials from current aggregate query shape', async () => {
    db.where.mockResolvedValueOnce([{
      gross: '1000',
      commission: '100',
      rpFee: '23',
      prodCost: '400',
      shipCost: '50',
      tax: '18',
      cnt: '1',
    }]);

    await expect(service.getAdminFinancialSummary(new Date('2026-01-01'), new Date('2026-01-31')))
      .resolves.toEqual({
        totalGrossRevenue: 1000,
        totalAdminCommission: 100,
        totalUserProfit: 409,
        totalSupplierPayable: 450,
        totalRazorpayFees: 23,
        orderCount: 1,
      });
  });
});
