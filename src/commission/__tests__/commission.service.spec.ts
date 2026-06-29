import { ForbiddenException } from '@nestjs/common';
import { CommissionService } from '../../commission/commission.service';

const fixedConfig = {
  id: 'cfg-1',
  isEnabled: true,
  commissionType: 'fixed',
  fixedAmount: '100',
  percentage: '0',
  appliedToCategory: null,
  minOrderValue: '0',
};

function makeDb(config: any = fixedConfig) {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(config ? [config] : []),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([config ?? fixedConfig]),
  };
}

describe('CommissionService current contract', () => {
  it('computes a fixed commission price floor', async () => {
    const service = new CommissionService(makeDb(fixedConfig) as any);

    await expect(service.computePriceFloor(500, 'INR')).resolves.toEqual({
      supplierPrice: 500,
      commissionAmount: 100,
      minimumAllowedPrice: 600,
      currency: 'INR',
    });
  });

  it('computes a percentage commission price floor', async () => {
    const service = new CommissionService(makeDb({
      ...fixedConfig,
      commissionType: 'percentage',
      fixedAmount: '0',
      percentage: '15',
    }) as any);

    await expect(service.computePriceFloor(1000, 'INR')).resolves.toEqual({
      supplierPrice: 1000,
      commissionAmount: 150,
      minimumAllowedPrice: 1150,
      currency: 'INR',
    });
  });

  it('passes through supplier price when commission is disabled or category does not match', async () => {
    await expect(new CommissionService(makeDb({ ...fixedConfig, isEnabled: false }) as any)
      .computePriceFloor(500, 'INR')).resolves.toMatchObject({ commissionAmount: 0, minimumAllowedPrice: 500 });

    await expect(new CommissionService(makeDb({ ...fixedConfig, appliedToCategory: 'electronics' }) as any)
      .computePriceFloor(500, 'INR', 'fitness')).resolves.toMatchObject({ commissionAmount: 0, minimumAllowedPrice: 500 });
  });

  it('returns only user-safe price info from getUserPriceInfo', async () => {
    const service = new CommissionService(makeDb(fixedConfig) as any);

    await expect(service.getUserPriceInfo(500, 'INR')).resolves.toEqual({
      minimumAllowedPrice: 600,
      currency: 'INR',
    });
  });

  it('rejects user selling prices below the hidden floor', async () => {
    const service = new CommissionService(makeDb(fixedConfig) as any);

    await expect(service.enforceMinimumPrice(599, 500, 'INR'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.enforceMinimumPrice(600, 500, 'INR')).resolves.toBeUndefined();
  });

  it('upserts existing and new admin configs', async () => {
    const existingDb = makeDb(fixedConfig);
    await new CommissionService(existingDb as any).upsertConfig('admin-1', {
      isEnabled: true,
      commissionType: 'fixed',
      fixedAmount: 150,
    });
    expect(existingDb.update).toHaveBeenCalled();

    const newDb = makeDb(null);
    await new CommissionService(newDb as any).upsertConfig('admin-1', {
      isEnabled: true,
      commissionType: 'percentage',
      percentage: 10,
    });
    expect(newDb.insert).toHaveBeenCalled();
  });
});
