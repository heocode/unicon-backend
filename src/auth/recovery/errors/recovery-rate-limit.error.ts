import { HttpException, HttpStatus } from '@nestjs/common';

export class RecoveryRateLimitError extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many password reset requests. Please try again later.',
        details: { retryAfterSeconds },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
