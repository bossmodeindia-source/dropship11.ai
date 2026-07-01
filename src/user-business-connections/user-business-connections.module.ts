import { Module } from '@nestjs/common';
import { UserBusinessConnectionsService } from './user-business-connections.service';
import {
  AdminWebsitePlatformsController,
  UserBusinessConnectionsController,
  WebsitePlatformsPublicController,
} from './user-business-connections.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [UserBusinessConnectionsService],
  controllers: [
    AdminWebsitePlatformsController,
    UserBusinessConnectionsController,
    WebsitePlatformsPublicController,
  ],
  exports: [UserBusinessConnectionsService],
})
export class UserBusinessConnectionsModule {}
