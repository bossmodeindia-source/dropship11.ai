import { Readable } from 'stream';
import { TelegramDeduplicationService } from '../telegram-deduplication.service';
import { TelegramRetentionService } from '../telegram-retention.service';

describe('telegram-storage deduplication phase1 coverage', () => {
  it('computes stable SHA-256 checksums for buffers and base64 input', () => {
    const service = new TelegramDeduplicationService({} as any, {} as any);
    const buffer = Buffer.from('asset-bytes');
    const base64 = buffer.toString('base64');

    expect(service.computeChecksum(buffer)).toBe(service.computeChecksum(base64));
    expect(service.computeChecksum(buffer)).toHaveLength(64);
  });

  it('returns a duplicate from Redis cache and removes stale cache entries', async () => {
    const asset = { id: 'asset-1', tenant_id: 'tenant-1', telegram_file_id: 'tg-file-1' };
    const repo = {
      findById: jest.fn().mockResolvedValueOnce(asset).mockResolvedValueOnce(null),
      findByChecksum: jest.fn().mockResolvedValue(null),
    };
    const redis = {
      get: jest.fn().mockResolvedValueOnce('asset-1').mockResolvedValueOnce('stale-asset'),
      del: jest.fn().mockResolvedValue(1),
      setex: jest.fn(),
    };
    const service = new TelegramDeduplicationService(repo as any, redis as any);

    await expect(service.findDuplicate('tenant-1', 'checksum')).resolves.toBe(asset);
    await expect(service.findDuplicate('tenant-1', 'checksum')).resolves.toBeNull();

    expect(repo.findById).toHaveBeenCalledWith('asset-1', 'tenant-1');
    expect(redis.del).toHaveBeenCalledWith('tg:dedup:tenant-1:checksum');
  });

  it('falls back to DB lookup and primes Redis when DB duplicate is found', async () => {
    const row = { id: 'asset-db', telegram_file_id: 'tg-file-db' };
    const repo = { findById: jest.fn(), findByChecksum: jest.fn().mockResolvedValue(row) };
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK'), del: jest.fn() };
    const service = new TelegramDeduplicationService(repo as any, redis as any);

    await expect(service.findDuplicate('tenant-1', 'checksum')).resolves.toBe(row);
    expect(redis.setex).toHaveBeenCalledWith('tg:dedup:tenant-1:checksum', 86400, 'asset-db');
  });

  it('caches and invalidates checksum mappings while swallowing Redis failures', async () => {
    const redis = { setex: jest.fn().mockRejectedValue(new Error('redis down')), del: jest.fn().mockRejectedValue(new Error('redis down')) };
    const service = new TelegramDeduplicationService({} as any, redis as any);

    await expect(service.cacheChecksum('tenant-1', 'checksum', 'asset-1')).resolves.toBeUndefined();
    await expect(service.invalidateChecksum('tenant-1', 'checksum')).resolves.toBeUndefined();
    expect(redis.setex).toHaveBeenCalledWith('tg:dedup:tenant-1:checksum', 86400, 'asset-1');
    expect(redis.del).toHaveBeenCalledWith('tg:dedup:tenant-1:checksum');
  });
});

describe('telegram-storage retention phase1 coverage', () => {
  const asset = (patch: Record<string, unknown> = {}) => ({
    id: 'asset-1',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    telegram_file_id: 'tg-file-1',
    storage_bot_id: 'bot-1',
    file_name: 'asset.png',
    mime_type: 'image/png',
    ...patch,
  });

  it('purges expired assets and continues when one delete fails', async () => {
    const repo = {
      findExpired: jest.fn().mockResolvedValue([asset({ id: 'ok' }), asset({ id: 'bad' })]),
      softDelete: jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('delete failed')),
    };
    const service = new TelegramRetentionService(repo as any, {} as any, {} as any, {} as any);

    await expect(service.purgeExpired()).resolves.toEqual({ purged: 1 });
    expect(repo.softDelete).toHaveBeenCalledWith('ok', 'tenant-1');
    expect(repo.softDelete).toHaveBeenCalledWith('bad', 'tenant-1');
  });

  it('archives cold assets to storage and marks missing Telegram references as failed', async () => {
    const repo = {
      findColdAssets: jest.fn().mockResolvedValue([asset({ id: 'archive-me' }), asset({ id: 'missing-file', telegram_file_id: null })]),
      updateAssetStatus: jest.fn().mockResolvedValue(undefined),
      markArchived: jest.fn().mockResolvedValue(undefined),
    };
    const storage = { upload: jest.fn().mockResolvedValue(undefined) };
    const download = { streamAsset: jest.fn().mockResolvedValue({ stream: Readable.from([Buffer.from('bytes')]) }) };
    const service = new TelegramRetentionService(repo as any, storage as any, { sendWarn: jest.fn() } as any, download as any);

    await expect(service.archiveColdAssets()).resolves.toEqual({ archived: 1, failed: 0 });
    expect(storage.upload).toHaveBeenCalledWith('tenant-1', 'exports', 'telegram-archive/archive-me/asset.png', Buffer.from('bytes'), 'image/png');
    expect(repo.markArchived).toHaveBeenCalledWith('archive-me', 'telegram-archive/archive-me/asset.png', 'r2-archive');
    expect(repo.updateAssetStatus).toHaveBeenCalledWith('missing-file', 'failed');
  });

  it('counts archive failures and warns when failures exceed threshold', async () => {
    const repo = { findColdAssets: jest.fn().mockResolvedValue([asset({ id: 'a1' }), asset({ id: 'a2' }), asset({ id: 'a3' }), asset({ id: 'a4' })]) };
    const alerting = { sendWarn: jest.fn().mockResolvedValue(undefined) };
    const download = { streamAsset: jest.fn().mockRejectedValue(new Error('telegram unavailable')) };
    const service = new TelegramRetentionService(repo as any, {} as any, alerting as any, download as any);

    await expect(service.archiveColdAssets()).resolves.toEqual({ archived: 0, failed: 4 });
    expect(alerting.sendWarn).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('Telegram Archive Failures') }));
  });

  it('repairs stored assets with broken Telegram references', async () => {
    const repo = { db: { query: jest.fn().mockResolvedValue({ rowCount: 3 }) } };
    const service = new TelegramRetentionService(repo as any, {} as any, {} as any, {} as any);

    await expect(service.repairBrokenReferences()).resolves.toEqual({ repaired: 3 });
    expect(repo.db.query).toHaveBeenCalledWith(expect.stringContaining("storage_status = 'stored'"));
  });
});
