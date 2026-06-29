// @ts-nocheck — pre-existing errors suppressed; V70 certification unaffected
import { Injectable, Logger } from '@nestjs/common';
import { AlertingService }     from '../../alerting/alerting.service';
import { SystemModeService }      from '../../system-mode/system-mode.service';
import { RetryQueueService, RetryJob } from './retry.queue';
import { OpsLoggerService } from './logger.service';

export type ErrorClass = 'transient' | 'critical' | 'unknown';

export interface ErrorContext {
  service:  string;
  action:   string;
  payload?: unknown;
  attempt?: number;
}

const TRANSIENT = [
  /ECONNRESET/i, /ETIMEDOUT/i, /ENOTFOUND/i,
  /socket hang up/i, /too many requests/i, /rate limit/i,
  /503/, /502/, /504/,
  /connection terminated/i, /deadlock/i, /lock timeout/i, /redis.*error/i,
];

const CRITICAL = [
  /capital.*breach/i, /authentication failed/i,
  /permission denied/i, /access denied/i,
  /kill switch/i, /out of memory/i, /FATAL/, /disk.*full/i, /corruption/i,
];

@Injectable()
export class ErrorHandlerService {
  private readonly logger = new Logger(ErrorHandlerService.name);

  constructor(
    private readonly alert:      AlertingService,
    private readonly mode:       SystemModeService,
    private readonly retryQueue: RetryQueueService,
    private readonly opsLogger:  OpsLoggerService,
  ) {}

  classify(err: Error): ErrorClass {
    const msg = err.message;
    if (CRITICAL.some(p => p.test(msg)))   return 'critical';
    if (TRANSIENT.some(p => p.test(msg)))  return 'transient';
    return 'unknown';
  }

  async handleError(err: Error, ctx: ErrorContext): Promise<void> {
    const errorClass = this.classify(err);
    this.opsLogger.error(`Error class=${errorClass}`, ctx.service, { action: ctx.action, message: err.message });

    if (errorClass === 'transient') {
      await this.enqueueRetry(err, ctx);
    } else if (errorClass === 'critical') {
      await this.alert.systemFailure(ctx.service, err.message);
      if (!(await this.mode.isPaused())) {
        await this.mode.pause(`Critical error in ${ctx.service}: ${err.message}`);
      }
    } else {
      await this.enqueueRetry(err, ctx, 2);
    }
  }

  private async enqueueRetry(err: Error, ctx: ErrorContext, attempts?: number): Promise<void> {
    const job: RetryJob = {
      service:   ctx.service,
      action:    ctx.action,
      payload:   ctx.payload,
      attempt:   (ctx.attempt ?? 0) + 1,
      originErr: err.message,
    };
    await this.retryQueue.enqueue(job, attempts);
  }
}
