import { AuditEntry, AuditService } from '../audit.service';

function makeDb() {
  return {
    execute: jest.fn().mockResolvedValue({ rows: [] }),
  };
}

describe('AuditService current contract', () => {
  let db: ReturnType<typeof makeDb>;
  let service: AuditService;

  beforeEach(() => {
    jest.useFakeTimers();
    db = makeDb();
    service = new AuditService(db as any);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  async function flushTimers() {
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
  }

  it('buffers audit entries and flushes them asynchronously', async () => {
    const entry: AuditEntry = {
      tenantId: 'tenant-1',
      actorId: 'user-1',
      action: 'ORDER_RECEIVED',
      resource: 'orders',
    };

    expect(service.log(entry)).toBeUndefined();
    expect(db.execute).not.toHaveBeenCalled();

    await flushTimers();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('records admin, security, vault, and financial helper events through log()', async () => {
    service.logAdminAction('admin-1', 'FREEZE_USER', 'users', 'user-1');
    service.logSecurityEvent('tenant-1', 'user-1', 'FAILED_AUTH');
    service.logVaultAccess('tenant-1', 'user-1', 'READ', 'shopify');
    service.logFinancialEvent('tenant-1', 'user-1', 'ESCROW_CREATED', 100, 'INR');

    await flushTimers();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('queries current audit rows through the Drizzle execute path', async () => {
    db.execute.mockResolvedValueOnce({
      rows: [{
        tenantId: 'tenant-1',
        actorId: 'user-1',
        action: 'ADMIN_FREEZE_USER',
        resource: 'users',
        severity: 'warn',
      }],
    });

    await expect(service.query({ tenantId: 'tenant-1' })).resolves.toEqual([
      expect.objectContaining({ action: 'ADMIN_FREEZE_USER' }),
    ]);
  });

  it('returns an empty list when query fails', async () => {
    db.execute.mockRejectedValueOnce(new Error('db down'));
    await expect(service.query({ tenantId: 'tenant-1' })).resolves.toEqual([]);
  });
});
