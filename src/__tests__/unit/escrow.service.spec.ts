import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EscrowTransactionService, CreateEscrowInput } from '../../escrow/escrow-transaction.service';
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

describe('EscrowTransactionService current contract', () => {
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

  it('calculates Razorpay fee and net amount', () => {
    expect(EscrowTransactionService.calculateFees(1000)).toEqual({
      razorpayFee: 23,
      netAfterGateway: 977,
    });
  });

  it('creates escrow idempotently and emits an outbox event inside the transaction', async () => {
    const result = await service.createEscrow(makeInput());

    expect(result).toEqual({ escrowId: 'esc-1', created: true });
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      db._tx,
      DomainEventType.ESCROW_CREATED,
      'tenant-1',
      expect.objectContaining({ orderId: 'order-1', userProfit: 409 }),
    );
  });

  it('returns the existing escrow on duplicate payment without emitting a second outbox event', async () => {
    db._tx.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'existing-escrow' }] });

    const result = await service.createEscrow(makeInput());

    expect(result).toEqual({ escrowId: 'existing-escrow', created: false });
    expect(outbox.publishInTx).not.toHaveBeenCalled();
  });

  it('rejects invalid status transitions', async () => {
    db.limit.mockResolvedValueOnce([makeEscrow({ status: 'SHIPPED' })]);

    await expect(
      service.advanceStatus('esc-1', 'ESCROW_CREATED', 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFoundException when advancing a missing escrow', async () => {
    db.limit.mockResolvedValueOnce([]);

    await expect(
      service.advanceStatus('missing', 'SUPPLIER_PAID', 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('emits profit distribution and delivery events on DELIVERED transition', async () => {
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
});
