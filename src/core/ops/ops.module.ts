import { Module, Global } from '@nestjs/common';
import { OpsLoggerService }    from './logger.service';
import { RetryQueueService }   from './retry.queue';
import { ErrorHandlerService } from './error-handler.service';
import { CacheService }        from './cache.service';
import { CapitalPoolService }  from './capital-pool.service';

@Global()
@Module({
  imports:   [
],
  providers: [OpsLoggerService, RetryQueueService, ErrorHandlerService, CacheService, CapitalPoolService],
  exports:   [OpsLoggerService, RetryQueueService, ErrorHandlerService, CacheService, CapitalPoolService],
})
export class OpsModule {}
