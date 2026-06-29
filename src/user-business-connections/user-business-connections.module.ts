import { Module } from '@nestjs/common';
import { UserBusinessConnectionsService } from './user-business-connections.service';
import { UserBusinessConnectionsController } from './user-business-connections.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [UserBusinessConnectionsService],
  controllers: [UserBusinessConnectionsController],
  exports: [UserBusinessConnectionsService],
})
export class UserBusinessConnectionsModule {}
