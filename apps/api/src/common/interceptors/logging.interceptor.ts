import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();

    const { method, url } = request;
    const correlationId = (request as any).correlationId || 'unknown';
    const startTime = Date.now();

    // Log the request start
    this.logger.log(
      JSON.stringify({
        message: `Inbound Request: ${method} ${url}`,
        service: 'api',
        correlationId,
        method,
        url,
        timestamp: new Date().toISOString(),
      })
    );

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        const statusCode = response.statusCode;

        this.logger.log(
          JSON.stringify({
            message: `Outbound Response: ${method} ${url} ${statusCode} - ${duration}ms`,
            service: 'api',
            correlationId,
            method,
            url,
            statusCode,
            durationMs: duration,
            timestamp: new Date().toISOString(),
          })
        );
      })
    );
  }
}
