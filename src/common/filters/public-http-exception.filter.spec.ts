import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

import { PublicHttpExceptionFilter } from './public-http-exception.filter';

describe('PublicHttpExceptionFilter', () => {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const setHeader = jest.fn();
  const response = { status, json, setHeader } as unknown as Response;
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as ArgumentsHost;
  let filter: PublicHttpExceptionFilter;

  beforeEach(() => {
    jest.clearAllMocks();
    filter = new PublicHttpExceptionFilter();
  });

  it('preserves the approved envelope and sets Retry-After', () => {
    filter.catch(
      new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests.',
          details: { retryAfterSeconds: 12.2 },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      host,
    );

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '13');
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests.',
      details: { retryAfterSeconds: 12.2 },
    });
  });

  it('normalizes an unstructured HTTP exception without exposing Nest fields', () => {
    filter.catch(new BadRequestException('Internal validator wording.'), host);

    expect(json).toHaveBeenCalledWith({
      code: 'VALIDATION_FAILED',
      message: 'The request could not be completed.',
    });
  });

  it('sanitizes unexpected errors', () => {
    filter.catch(new Error('database secret'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  });
});
