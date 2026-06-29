import { BadRequestException } from '@nestjs/common';
import { WalletService } from '../wallet.service';

type SelectStep = { rows: unknown[]; projected?: boolean };

const makeDb = (selectSteps: SelectStep[] = []) => {
  const state = {
    selectSteps: [...selectSteps],
    inserts: [] as any[],
    updates: [] as any[],
  };

  const db: any = {
    select: jest.fn((projection?: unknown) => {
      const step = state.selectSteps.shift() ?? { rows: [] };
      const chain: any = {
        from: jest.fn(() => chain),
        where: jest.fn(() => chain),
        orderBy: jest.fn(() => chain),
        limit: jest.fn(() => Promise.resolve(step.rows)),
      };
      if (projection) step.projected = true;
      return chain;
    }),
    insert: jest.fn(() => {
      const chain: any = {
        values: jest.fn((value: any) => {
          state.inserts.push(value);
          return chain;
        }),
        onConflictDoNothing: jest.fn(() => chain),
        returning: jest.fn(() => Promise.resolve([{ id: 'tx-1', userId: 'user-1', balance: '0.00', currency: 'INR', updatedAt: new Date('2026-01-01'), type: state.inserts.at(-1)?.type ?? 'REFUND', status: 'COMPLETED', amount: state.inserts.at(-1)?.amount ?? '0', balanceAfter: state.inserts.at(-1)?.balanceAfter ?? '0', description: state.inserts.at(-1)?.description ?? 'created', orderId: state.inserts.at(-1)?.orderId ?? null, createdAt: new Date('2026-01-01') }])),
      };
      return chain;
    }),
    update: jest.fn(() => {
      const chain: any = {
        set: jest.fn((value: any) => {
          state.updates.push(value);
          return chain;
        }),
        where: jest.fn(() => chain),
        returning: jest.fn(() => Promise.resolve([{ id: 'wallet-1' }])),
      };
      return chain;
    }),
    __state: state,
  };

  return db;
};

describe('wallet.service phase1 coverage', () => {
  it('auto-creates a wallet balance on first read', async () => {
    const db = makeDb([{ rows: [] }]);
    const service = new WalletService(db, { log: jest.fn() } as any);

    await expect(service.getBalance('user-1')).resolves.toEqual({ userId: 'user-1', balance: 0, currency: 'INR', updatedAt: new Date('2026-01-01') });
    expect(db.__state.inserts[0]).toEqual({ userId: 'user-1', balance: '0.00', currency: 'INR' });
  });

  it('credits wallet balance, writes ledger entry, and audits the credit', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const db = makeDb([
      { rows: [{ userId: 'user-1', balance: '100.00', currency: 'INR', updatedAt: new Date('2026-01-01') }] },
      { rows: [{ balance: '100.00', version: 2 }] },
    ]);
    const service = new WalletService(db, audit as any);

    const tx = await service.credit('user-1', { amount: 25.5, type: 'REFUND', description: 'Refund', orderId: 'order-1' });

    expect(db.__state.updates[0]).toEqual(expect.objectContaining({ balance: '125.5', version: 3 }));
    expect(tx).toEqual(expect.objectContaining({ type: 'REFUND', amount: 25.5, balanceAfter: 125.5, orderId: 'order-1' }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.credit', userId: 'user-1' }));
  });

  it('debits wallet balance and refuses insufficient funds', async () => {
    const db = makeDb([
      { rows: [{ userId: 'user-1', balance: '100.00', currency: 'INR', updatedAt: new Date('2026-01-01') }] },
      { rows: [{ balance: '100.00', version: 1 }] },
      { rows: [{ userId: 'user-1', balance: '10.00', currency: 'INR', updatedAt: new Date('2026-01-01') }] },
      { rows: [{ balance: '10.00', version: 2 }] },
    ]);
    const service = new WalletService(db, { log: jest.fn() } as any);

    await expect(service.debit('user-1', { amount: 40, description: 'Withdrawal' })).resolves.toEqual(expect.objectContaining({
      type: 'WITHDRAWAL',
      amount: -40,
      balanceAfter: 60,
    }));
    await expect(service.debit('user-1', { amount: 20, description: 'Too much' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates positive credit and debit amounts', async () => {
    const service = new WalletService(makeDb(), { log: jest.fn() } as any);

    await expect(service.credit('user-1', { amount: 0, type: 'BONUS', description: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.debit('user-1', { amount: -1, description: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists transactions in descending order through the repository query', async () => {
    const createdAt = new Date('2026-01-01');
    const db = makeDb([{ rows: [{ id: 'tx-1', type: 'REFUND', status: 'COMPLETED', amount: '50.00', balanceAfter: '75.00', currency: 'INR', description: 'Refund', orderId: 'order-1', createdAt }] }]);
    const service = new WalletService(db, { log: jest.fn() } as any);

    await expect(service.getTransactions('user-1', 10)).resolves.toEqual([{ id: 'tx-1', type: 'REFUND', status: 'COMPLETED', amount: 50, balanceAfter: 75, currency: 'INR', description: 'Refund', orderId: 'order-1', createdAt }]);
  });
});
