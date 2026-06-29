import { Module } from '@nestjs/common';
import { UserAiConnectionsService } from './user-ai-connections.service';
import { UserAiConnectionsController } from './user-ai-connections.controller';
import { UserAiRouterService } from './user-ai-router.service';
import { AiProviderRegistryModule } from '../ai-provider-registry/ai-provider-registry.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AiProviderRegistryModule, AuditModule],
  providers: [UserAiConnectionsService, UserAiRouterService],
  controllers: [UserAiConnectionsController],
  exports: [UserAiConnectionsService, UserAiRouterService],
})
export class UserAiConnectionsModule {}
