/**
 * AiMediaModule — PATCHED
 *
 * FIX #3: AiOrchestratorModule imported so AiMediaService can inject
 * AiOrchestratorService. All media prompt generation now goes through
 * the full orchestration pipeline (cache, safety, quota, fallback).
 */

import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AiMediaService } from './ai-media.service';
import { AiMediaClient } from './ai-media.client';
import { AiMediaController } from './ai-media.controller';
import { AdMediaAssetsRepository } from './ad-media-assets.repository';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';

@Module({
  imports: [
    MulterModule.register({ storage: memoryStorage() }),
    // FIX #3: Required so AiMediaService can inject AiOrchestratorService
    AiOrchestratorModule,
  ],
  controllers: [AiMediaController],
  providers:   [AiMediaService, AiMediaClient, AdMediaAssetsRepository],
  exports:     [AiMediaService, AdMediaAssetsRepository],
})
export class AiMediaModule {}
