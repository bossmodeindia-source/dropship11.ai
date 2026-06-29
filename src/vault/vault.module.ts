import { Module, Global } from '@nestjs/common';
import { VaultService }    from './vault.service';
import { VaultController } from './vault.controller';
import { DatabaseModule }  from '../common/database/database.module';
import { AuditModule }     from '../audit/audit.module';

/**
 * VaultModule — V59 AES-256-GCM Encrypted Credential Store
 *
 * @Global — VaultService injected by ShopifyModule, MetaAdsModule,
 * AiOrchestratorModule, and OrganicModule to retrieve decrypted
 * third-party API keys at execution time only.
 *
 * Depends on:
 *   DatabaseModule — vault_credentials table (ciphertext, IV, auth_tag)
 *   AuditModule    — every credential access audit-logged
 *
 * Master key (VAULT_MASTER_KEY) lives ONLY in env — never stored in DB.
 * Each credential encrypted with unique random IV (AES-256-GCM).
 */
@Global()
@Module({
  imports:     [DatabaseModule, AuditModule],
  controllers: [VaultController],
  providers:   [VaultService],
  exports:     [VaultService],
})
export class VaultModule {}
