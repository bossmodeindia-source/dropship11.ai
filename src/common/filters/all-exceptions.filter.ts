import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response }   from 'express';
import { recordErrorOnSpan }   from '../../observability/tracing'; // V65: OTEL error recording

/**
 * Catches ALL unhandled exceptions (including non-HTTP ones like DB errors).
 * Registered AFTER HttpExceptionFilter so Http exceptions are handled there first.
 *
 * V65: Records the exception on the active OTEL span so Jaeger shows full
 * error details on the trace, correlated with tenant and request ID.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx      = host.switchToHttp();
    const request  = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const err    = exception instanceof Error ? exception : new Error(String(exception));
    const status = HttpStatus.INTERNAL_SERVER_ERROR;

    // Log full stack trace
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url}: ${err.message}`,
      err.stack,
    );

    // V65: Record on active OTEL span so Jaeger shows this error
    recordErrorOnSpan(err);

    // Never expose internal details in production
    const isProd = process.env.NODE_ENV === 'production';

    response.status(status).json({
      statusCode: status,
      message:    isProd ? 'An unexpected error occurred' : err.message,
      error:      'InternalServerError',
      timestamp:  new Date().toISOString(),
      path:       request.url,
      requestId:  request.headers['x-request-id'],
    });
  }
}
