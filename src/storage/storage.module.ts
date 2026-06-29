import { Module, Global } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * StorageModule — V59 S3 / Cloudflare R2 Object Storage
 *
 * @Global — StorageService used by CreativeEngine, AdCreatives, AiMedia,
 * and Analytics exporters across many modules.
 *
 * Credentials (STORAGE_ENDPOINT, STORAGE_ACCESS_KEY, etc.) read from
 * ConfigService; no NestJS DB/Redis dependency — pure AWS SDK client.
 */
@Global()
@Module({
  providers: [StorageService],
  exports:   [StorageService],
})
export class StorageModule {}
