/**
 * StorageService — V59 S3/Cloudflare R2 Object Storage
 *
 * Handles all file storage for the platform:
 *   - Ad creatives (images, videos)
 *   - Generated product images
 *   - Analytics exports (CSV, PDF)
 *   - Campaign reports
 *   - Supplier catalogs
 *
 * Compatible with any S3-compatible API:
 *   - AWS S3
 *   - Cloudflare R2 (recommended — egress-free)
 *   - MinIO (self-hosted)
 *   - DigitalOcean Spaces
 *
 * Key namespacing: {tenantId}/{category}/{date}/{filename}
 *   Example: abc-123/creatives/2024-01-15/ad-banner-v3.jpg
 *
 * Features:
 *   - Pre-signed URLs for direct browser upload (no proxy)
 *   - Pre-signed download URLs (time-limited, tenant-isolated)
 *   - CDN URL generation for served assets
 *   - Automatic content-type detection
 *   - Tenant isolation enforced via key prefix
 */

import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as path from 'path';
import * as crypto from 'crypto';

export type StorageCategory =
  | 'creatives'
  | 'videos'
  | 'exports'
  | 'catalogs'
  | 'thumbnails'
  | 'reports';

export interface StorageFile {
  key: string;
  url: string;
  cdnUrl?: string;
  size: number;
  contentType: string;
  uploadedAt: Date;
}

export interface PresignedUpload {
  uploadUrl: string;
  storageKey: string;
  expiresIn: number;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.pdf':  'application/pdf',
  '.csv':  'text/csv',
  '.zip':  'application/zip',
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly cdnBase: string;
  private readonly presignTtl = 3600; // 1 hour

  constructor(private readonly config: ConfigService) {
    const endpoint  = this.config.get<string>('STORAGE_ENDPOINT');
    const region    = this.config.get<string>('STORAGE_REGION', 'auto');
    const accessKey = this.config.getOrThrow<string>('STORAGE_ACCESS_KEY');
    const secretKey = this.config.getOrThrow<string>('STORAGE_SECRET_KEY');

    this.bucket  = this.config.getOrThrow<string>('STORAGE_BUCKET');
    this.cdnBase = this.config.get<string>('STORAGE_CDN_BASE', '');

    // Supabase Storage uses the S3-compatible API with path-style URLs.
    // Endpoint format: https://<project-ref>.supabase.co/storage/v1/s3
    // Cloudflare R2 uses virtual-hosted style (forcePathStyle: false).
    // Auto-detect: use path style when endpoint contains supabase.co.
    const isSupabase = endpoint?.includes('supabase.co');

    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: isSupabase ? true : false } : {}),
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  async upload(
    tenantId: string,
    category: StorageCategory,
    filename: string,
    body: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<StorageFile> {
    const key = this.buildKey(tenantId, category, filename);
    const ct  = contentType ?? this.detectContentType(filename);

    await this.client.send(new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      Body:        body,
      ContentType: ct,
      Metadata:    { tenant_id: tenantId },
    }));

    this.logger.log(`Uploaded ${key} (${body.length} bytes)`);

    return {
      key,
      url:         this.buildS3Url(key),
      cdnUrl:      this.buildCdnUrl(key),
      size:        body.length,
      contentType: ct,
      uploadedAt:  new Date(),
    };
  }

  // ── Pre-signed upload URL (direct browser → R2 upload) ───────────────────

  async getPresignedUploadUrl(
    tenantId: string,
    category: StorageCategory,
    filename: string,
  ): Promise<PresignedUpload> {
    const key = this.buildKey(tenantId, category, filename);
    const cmd = new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      ContentType: this.detectContentType(filename),
      Metadata:    { tenant_id: tenantId },
    });

    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: this.presignTtl });
    return { uploadUrl, storageKey: key, expiresIn: this.presignTtl };
  }

  // ── Pre-signed download URL ───────────────────────────────────────────────

  async getPresignedDownloadUrl(tenantId: string, key: string): Promise<string> {
    this.assertKeyBelongsToTenant(tenantId, key);
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: this.presignTtl });
  }

  // ── List files for a tenant ───────────────────────────────────────────────

  async listFiles(
    tenantId: string,
    category?: StorageCategory,
    limit = 50,
  ): Promise<{ key: string; size: number; lastModified: Date }[]> {
    const prefix = category ? `${tenantId}/${category}/` : `${tenantId}/`;
    const res    = await this.client.send(new ListObjectsV2Command({
      Bucket:  this.bucket,
      Prefix:  prefix,
      MaxKeys: limit,
    }));

    return (res.Contents ?? []).map(obj => ({
      key:          obj.Key!,
      size:         obj.Size ?? 0,
      lastModified: obj.LastModified ?? new Date(),
    }));
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(tenantId: string, key: string): Promise<void> {
    this.assertKeyBelongsToTenant(tenantId, key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    this.logger.log(`Deleted ${key}`);
  }

  // ── CDN URL (for serving in frontend) ────────────────────────────────────

  getCdnUrl(key: string): string {
    return this.buildCdnUrl(key);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildKey(tenantId: string, category: StorageCategory, filename: string): string {
    const date    = new Date().toISOString().slice(0, 10);
    const safe    = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const hash    = crypto.randomBytes(4).toString('hex');
    return `${tenantId}/${category}/${date}/${hash}-${safe}`;
  }

  private buildS3Url(key: string): string {
    return `https://${this.bucket}.s3.amazonaws.com/${key}`;
  }

  private buildCdnUrl(key: string): string {
    if (this.cdnBase) return `${this.cdnBase.replace(/\/$/, '')}/${key}`;
    return this.buildS3Url(key);
  }

  private detectContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
  }

  private assertKeyBelongsToTenant(tenantId: string, key: string): void {
    if (!key.startsWith(`${tenantId}/`)) {
      throw new ForbiddenException(`Storage key does not belong to tenant`);
    }
  }
}
