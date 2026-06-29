/**
 * TelegramBotPoolModule — bot provisioning, routing, health, and channel management.
 * Imported by TelegramStorageModule.
 */

import { Module }                        from '@nestjs/common';
import { TelegramBotPoolService }        from './telegram-bot-pool.service';
import { TelegramBotRoutingService }     from './telegram-bot-routing.service';
import { TelegramBotHealthService }      from './telegram-bot-health.service';
import { TelegramBotProvisioningService } from './telegram-bot-provisioning.service';
import { TelegramChannelManagerService } from './telegram-channel-manager.service';
import { TelegramAssetRepository }       from '../telegram-storage/telegram-asset.repository';

// Shared deps (assumed globally provided)
// DatabaseModule, RedisModule, EncryptionModule, AuditModule, AlertingModule
// are registered globally in AppModule.

@Module({
  providers: [
    TelegramBotPoolService,
    TelegramBotRoutingService,
    TelegramBotHealthService,
    TelegramBotProvisioningService,
    TelegramChannelManagerService,
    TelegramAssetRepository,
  ],
  exports: [
    TelegramBotPoolService,
    TelegramBotRoutingService,
    TelegramBotHealthService,
    TelegramBotProvisioningService,
    TelegramChannelManagerService,
  ],
})
export class TelegramBotPoolModule {}
