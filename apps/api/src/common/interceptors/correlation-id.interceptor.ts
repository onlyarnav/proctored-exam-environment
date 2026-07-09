import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();

    // 1. Get or generate correlation ID
    let correlationId = request.headers['x-correlation-id'] as string;
    if (!correlationId) {
      correlationId = `req_${randomUUID().replace(/-/g, '')}`;
      request.headers['x-correlation-id'] = correlationId;
    }

    // 2. Set on request object for easy internal access
    (request as any).correlationId = correlationId;

    // 3. Attach correlation ID to response headers
    response.setHeader('x-correlation-id', correlationId);

    return next.handle();
  }
}
