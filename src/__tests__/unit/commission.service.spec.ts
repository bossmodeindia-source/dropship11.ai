import { ForbiddenException } from '@nestjs/common';
import { CommissionService } from '../../commission/commission.service';

const makeDb = (existingConfig: Record<string, unknown> | null = null) => {
  const db: any = {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  };

  db.select.mockReturnValue({
    from: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(existingConfig ? [existingConfig] : []),
    }),
  });

  db.insert.mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'config-1', createdBy: 'admin-1', ...existingConfig }]),
    }),
  });

  db.update.mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 'config-1', ...existingConfig }]),
      }),
    }),
  });

  return db;
};

describe('CommissionService current contract', () => {
  it('returns supplier price as the floor when commission is disabled', async () => {
    const service = new CommissionService(makeDb(null));

    await expect(service.computePriceFloor(500, 'INR', 'electronics')).resolves.toEqual({
      supplierPrice: 500,
      commissionAmount: 0,
      minimumAllowedPrice: 500,
      currency: 'INR',
    });
  });

  it('computes fixed and percentage hidden commission floors', async () => {
    const fixed = new CommissionService(makeDb({
      isEnabled: true,
      commissionType: 'fixed',
      fixedAmount: '100',
      percentage: '0',
      appliedToCategory: null,
    }));
    await expect(fixed.computePriceFloor(500, 'INR')).resolves.toEqual(
      expect.objectContaining({ commissionAmount: 100, minimumAllowedPrice: 600 }),
    );

    const percentage = new CommissionService(makeDb({
      isEnabled: true,
      commissionType: 'percentage',
      fixedAmount: '0',
      percentage: '15',
      appliedToCategory: null,
    }));
    await expect(percentage.computePriceFloor(1000, 'INR')).resolves.toEqual(
      expect.objectContaining({ commissionAmount: 150, minimumAllowedPrice: 1150 }),
    );
  });

  it('does not expose internal commission fields in user price info', async () => {
    const service = new CommissionService(makeDb({
      isEnabled: true,
      commissionType: 'fixed',
      fixedAmount: '75',
      percentage: '0',
      appliedToCategory: null,
    }));

    await expect(service.getUserPriceInfo(500, 'INR')).resolves.toEqual({
      minimumAllowedPrice: 575,
      currency: 'INR',
    });
  });

  it('blocks user selling prices below the hidden floor', async () => {
    const service = new CommissionService(makeDb({
      isEnabled: true,
      commissionType: 'fixed',
      fixedAmount: '100',
      percentage: '0',
      appliedToCategory: null,
    }));

    await expect(service.enforceMinimumPrice(599, 500, 'INR')).rejects.toThrow(ForbiddenException);
    await expect(service.enforceMinimumPrice(600, 500, 'INR')).resolves.toBeUndefined();
  });

  it('upserts admin commission config through create and update paths', async () => {
    const createDb = makeDb(null);
    const createService = new CommissionService(createDb);
    await createService.upsertConfig('admin-1', {
      isEnabled: true,
      commissionType: 'percentage',
      percentage: 12,
    });
    expect(createDb.insert).toHaveBeenCalled();

    const updateDb = makeDb({ id: 'config-1', isEnabled: true });
    const updateService = new CommissionService(updateDb);
    await updateService.setCommissionRate('tenant-1', 10, 'admin-1');
    expect(updateDb.update).toHaveBeenCalled();
  });
});
