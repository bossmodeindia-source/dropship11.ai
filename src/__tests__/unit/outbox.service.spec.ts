import { OutboxService } from '../../outbox/outbox.service';
import { DomainEventType } from '../../common/events/domain-events';

function makeInsertChain(capture: (value: unknown) => void = () => undefined) {
  return {
    values: jest.fn((value) => {
      capture(value);
      return Promise.resolve(undefined);
    }),
  };
}

describe('OutboxService current contract', () => {
  let db: any;
  let redis: { xadd: jest.Mock };
  let alerting: { sendCritical: jest.Mock };
  let service: OutboxService;

  beforeEach(() => {
    db = {
      insert: jest.fn(() => makeInsertChain()),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'event-1' }]),
      execute: jest.fn().mockResolvedValue({ rows: [] }),
      transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };
    redis = { xadd: jest.fn().mockResolvedValue('stream-id') };
    alerting = { sendCritical: jest.fn().mockResolvedValue(undefined) };
    service = new OutboxService(db, redis as any, alerting as any);
  });

  it('enqueueInTx writes an event using the same transaction handle', async () => {
    let captured: any;
    const tx = {
      insert: jest.fn(() => makeInsertChain((value) => {
        captured = value;
      })),
    };

    const id = await service.enqueueInTx(tx as any, {
      eventType: DomainEventType.ESCROW_CREATED,
      tenantId: 'tenant-1',
      aggregateId: 'order-1',
      aggregateType: 'order',
      payload: { orderId: 'order-1' },
    });

    expect(id).toEqual(expect.any(String));
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(captured).toEqual(expect.objectContaining({
      eventType: DomainEventType.ESCROW_CREATED,
      tenantId: 'tenant-1',
      status: 'PENDING',
      payload: expect.objectContaining({ orderId: 'order-1' }),
    }));
  });

  it('writeWithOutbox runs the business write and outbox insert in one transaction', async () => {
    const businessWrite = jest.fn().mockResolvedValue({ id: 'record-1' });

    const result = await service.writeWithOutbox(businessWrite, {
      eventType: DomainEventType.ORDER_PAID,
      tenantId: 'tenant-1',
      payload: { orderId: 'order-1' },
    });

    expect(result).toEqual({ id: 'record-1' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(businessWrite).toHaveBeenCalledWith(db);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('publish writes a pending event outside an existing transaction', async () => {
    let captured: any;
    db.insert.mockReturnValueOnce(makeInsertChain((value) => {
      captured = value;
    }));

    await service.publish(DomainEventType.PAYMENT_CAPTURED, 'tenant-1', { paymentId: 'pay-1' });

    expect(captured).toEqual(expect.objectContaining({
      eventType: DomainEventType.PAYMENT_CAPTURED,
      tenantId: 'tenant-1',
      status: 'PENDING',
      payload: { paymentId: 'pay-1' },
    }));
  });

  it('replayFailed resets failed events to pending', async () => {
    await expect(service.replayFailed('tenant-1')).resolves.toEqual({ replayed: 1 });
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'PENDING',
      attempts: 0,
      error: null,
      sentAt: null,
    }));
  });

  it('getStats returns numeric outbox counts', async () => {
    db.execute
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] });

    await expect(service.getStats()).resolves.toEqual({
      pending: 2,
      processing: 1,
      failed: 3,
      sent24h: 4,
    });
  });
});
