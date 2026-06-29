import { Module }                    from '@nestjs/common';
import { BullModule }                from '@nestjs/bullmq';
import { VideoPipelineService } from './video-pipeline.service';
import { VideoPipelineController }   from './video-pipeline.controller';
import { VideoPipelineProcessor }    from './workers/video-pipeline.processor';
import { FFmpegAssemblyService }     from './ffmpeg/ffmpeg-assembly.service';
import { UserAiConnectionsModule }   from '../user-ai-connections/user-ai-connections.module';
import { TelegramStorageModule }     from '../telegram-storage/telegram-storage.module';
import { CreativeViralityModule }    from '../creative-virality/creative-virality.module';
import { CanonicalQueue }            from '../queue/canonical-queues';
import { DatabaseModule }            from '../common/database/database.module';

@Module({
  imports: [
    DatabaseModule,
    UserAiConnectionsModule,
    TelegramStorageModule,
    CreativeViralityModule,
    BullModule.registerQueue({ name: CanonicalQueue.CREATIVE_GENERATION }),
  ],
  providers: [VideoPipelineService, VideoPipelineProcessor, FFmpegAssemblyService],
  controllers: [VideoPipelineController],
  exports: [VideoPipelineService, FFmpegAssemblyService],
})
export class VideoPipelineModule {}
