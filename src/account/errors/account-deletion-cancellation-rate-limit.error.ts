import { HttpException, HttpStatus } from '@nestjs/common';

export class AccountDeletionCancellationRateLimitError extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        code: 'RATE_LIMIT_EXCEEDED',
        message:
          'Too many account deletion cancellation attempts. Please try again later.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
