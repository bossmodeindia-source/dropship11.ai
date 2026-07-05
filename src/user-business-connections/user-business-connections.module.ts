import { Module } from '@nestjs/common';
import { UserBusinessConnectionsService } from './user-business-connections.service';
import {
  AdminWebsitePlatformsController,
  StoreProviderWebhooksController,
  UserBusinessConnectionsController,
  WebsitePlatformsPublicController,
} from './user-business-connections.controller';
import { AuditModule } from '../audit/audit.module';
import { WebhookModule } from '../common/webhook/webhook.module';

@Module({
  imports: [AuditModule, WebhookModule],
  providers: [UserBusinessConnectionsService],
  controllers: [
    AdminWebsitePlatformsController,
    StoreProviderWebhooksController,
    UserBusinessConnectionsController,
    WebsitePlatformsPublicController,
  ],
  exports: [UserBusinessConnectionsService],
})
export class UserBusinessConnectionsModule {}
