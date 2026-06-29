import { Module } from '@nestjs/common';
import { ConfigVaultService } from './config-vault.service';
import { DatabaseModule } from '../common/database/database.module';
import { CryptoModule } from '../common/crypto/crypto.module';

@Module({
  imports:   [DatabaseModule, CryptoModule],
  providers: [ConfigVaultService],
  exports:   [ConfigVaultService],
})
export class ConfigVaultModule {}
