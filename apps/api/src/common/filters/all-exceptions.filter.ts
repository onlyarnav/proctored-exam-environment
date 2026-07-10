import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCode } from 'shared-types';
import { Prisma } from '@prisma/client';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    
    const correlationId = (request.headers['x-correlation-id'] as string) || 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = ErrorCode.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred';
    let details: Record<string, any> | undefined = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resContent = exception.getResponse();

      if (typeof resContent === 'object' && resContent !== null) {
        const errorMsg = (resContent as any).message;
        message = Array.isArray(errorMsg) ? errorMsg[0] : errorMsg || exception.message;
        
        const customCode = (resContent as any).code;
        if (customCode) {
          code = customCode;
        } else if (status === HttpStatus.BAD_REQUEST && Array.isArray((resContent as any).message)) {
          code = ErrorCode.VALIDATION_ERROR;
          details = { validationErrors: (resContent as any).message };
        } else {
          // Attempt to map HTTP exceptions to our standard error codes
          code = this.mapHttpStatusToErrorCode(status);
        }
      } else {
        message = exception.message || String(resContent);
        code = this.mapHttpStatusToErrorCode(status);
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Handle unique constraint violations
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = ErrorCode.EMAIL_ALREADY_EXISTS;
        message = 'Email already exists';
        details = { target: exception.meta?.target };
      } else {
        status = HttpStatus.BAD_REQUEST;
        code = ErrorCode.VALIDATION_ERROR;
        message = 'Database request failed';
        details = { prismaCode: exception.code };
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Log the exception details
    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          message: `Unhandled exception: ${message}`,
          correlationId,
          path: request.url,
          stack: exception instanceof Error ? exception.stack : undefined,
        })
      );
    } else {
      this.logger.warn(
        JSON.stringify({
          message: `Request exception: ${message}`,
          correlationId,
          path: request.url,
          code,
        })
      );
    }

    // Format response payload per standard error envelope
    response.status(status).json({
      error: {
        code,
        message,
        correlationId,
        ...(details ? { details } : {}),
      },
    });
  }

  private mapHttpStatusToErrorCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.TOO_MANY_REQUESTS;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.ROUTE_NOT_FOUND;
      default:
        return ErrorCode.INTERNAL_SERVER_ERROR;
    }
  }
}
