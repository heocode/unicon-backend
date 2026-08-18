import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  PUBLIC_ERROR_CODES,
  type PublicErrorCode,
} from '../types/public-error-code.type';

type PublicErrorBody = {
  code: PublicErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

const publicErrorCodes = new Set<string>(PUBLIC_ERROR_CODES);

@Catch()
export class PublicHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (!(exception instanceof HttpException)) {
      this.logUnexpectedError(exception);
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      } satisfies PublicErrorBody);
      return;
    }

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    if (this.isMalformedJson(exception, exceptionResponse)) {
      response.status(HttpStatus.BAD_REQUEST).json({
        code: 'MALFORMED_JSON',
        message: 'The request body contains malformed JSON.',
      } satisfies PublicErrorBody);
      return;
    }

    const body = this.toPublicBody(status, exceptionResponse);

    if (status === 429 && typeof body.details?.retryAfterSeconds === 'number') {
      response.setHeader(
        'Retry-After',
        Math.ceil(body.details.retryAfterSeconds).toString(),
      );
    }

    if (status >= 500) {
      this.logUnexpectedError(exception);
    }

    response.status(status).json(body);
  }

  private toPublicBody(
    status: HttpStatus,
    response: string | object,
  ): PublicErrorBody {
    if (typeof response === 'object' && response !== null) {
      const record = response as Record<string, unknown>;
      if (!this.isPublicCode(record.code)) {
        return {
          code: this.defaultCode(status),
          message: this.defaultMessage(status),
        };
      }

      const code = record.code;
      const message =
        typeof record.message === 'string'
          ? record.message
          : this.defaultMessage(status);
      const details = this.readDetails(record);

      return details ? { code, message, details } : { code, message };
    }

    return {
      code: this.defaultCode(status),
      message: this.defaultMessage(status),
    };
  }

  private isPublicCode(value: unknown): value is PublicErrorCode {
    return typeof value === 'string' && publicErrorCodes.has(value);
  }

  private readDetails(
    response: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (
      typeof response.details === 'object' &&
      response.details !== null &&
      !Array.isArray(response.details)
    ) {
      return response.details as Record<string, unknown>;
    }

    return undefined;
  }

  private defaultCode(status: HttpStatus): PublicErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_FAILED';
      case HttpStatus.UNAUTHORIZED:
        return 'INVALID_CREDENTIALS';
      case HttpStatus.FORBIDDEN:
        return 'ACCOUNT_UNAVAILABLE';
      case HttpStatus.NOT_FOUND:
        return 'RESOURCE_NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'ACCOUNT_STATE_CHANGED';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT_EXCEEDED';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'INTERNAL_ERROR';
    }
  }

  private defaultMessage(status: HttpStatus): string {
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return 'The service is temporarily unavailable.';
    }

    return 'The request could not be completed.';
  }

  private logUnexpectedError(exception: unknown): void {
    this.logger.error(
      'A public HTTP request failed unexpectedly.',
      exception instanceof Error ? exception.stack : undefined,
    );
  }

  private isMalformedJson(
    exception: HttpException,
    response: string | object,
  ): boolean {
    const exceptionRecord = exception as HttpException & {
      cause?: unknown;
      type?: unknown;
    };
    const responseMessage =
      typeof response === 'object' &&
      response !== null &&
      typeof (response as Record<string, unknown>).message === 'string'
        ? ((response as Record<string, unknown>).message as string)
        : typeof response === 'string'
          ? response
          : '';

    return (
      exceptionRecord.cause instanceof SyntaxError ||
      exceptionRecord.type === 'entity.parse.failed' ||
      /JSON|Unexpected end|Unexpected token/u.test(responseMessage)
    );
  }
}
