import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { BrandService } from './brand.service';
import { BrandController } from './brand.controller';

@Module({
  imports: [DatabaseModule, AiOrchestratorModule],
  providers: [BrandService],
  controllers: [BrandController],
  exports: [BrandService],
})
export class BrandModule {}
