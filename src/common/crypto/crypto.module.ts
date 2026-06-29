import { Module, Global } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/**
 * Global crypto module — import once in AppModule, available everywhere.
 */
@Global()
@Module({
  providers: [EncryptionService],
  exports:   [EncryptionService],
})
export class CryptoModule {}
