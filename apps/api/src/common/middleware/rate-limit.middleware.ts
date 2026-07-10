import { Injectable, NestMiddleware, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ErrorCode } from 'shared-types';

interface RateLimitInfo {
  timestamps: number[];
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  // In-memory fallback store
  public static readonly store = new Map<string, RateLimitInfo>();
  
  // Rate limit config: max 5 requests per 60 seconds
  private readonly windowMs = 60 * 1000;
  private readonly maxRequests = 5;

  use(request: Request, response: Response, next: NextFunction) {
    const ip = request.ip || request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown';
    const path = request.path;
    
    // Create a key based on IP and Path (so different paths have separate limits)
    const key = `${ip}:${path}`;
    const correlationId = (request as any).correlationId || (request.headers['x-correlation-id'] as string) || 'unknown';

    const now = Date.now();
    let clientInfo = RateLimitMiddleware.store.get(key);

    if (!clientInfo) {
      clientInfo = { timestamps: [] };
      RateLimitMiddleware.store.set(key, clientInfo);
    }

    // Filter out timestamps outside the window
    clientInfo.timestamps = clientInfo.timestamps.filter(
      (time) => now - time < this.windowMs
    );

    if (clientInfo.timestamps.length >= this.maxRequests) {
      response.status(HttpStatus.TOO_MANY_REQUESTS).json({
        error: {
          code: ErrorCode.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again after some time.',
          correlationId,
        },
      });
      return;
    }

    // Add current timestamp to request log and allow
    clientInfo.timestamps.push(now);
    next();
  }
}
