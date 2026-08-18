import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { AccountDeletionCancellationRateLimitError } from '../errors/account-deletion-cancellation-rate-limit.error';

@Catch(AccountDeletionCancellationRateLimitError)
export class AccountDeletionCancellationRateLimitFilter implements ExceptionFilter {
  catch(
    exception: AccountDeletionCancellationRateLimitError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();

    response.setHeader('Retry-After', exception.retryAfterSeconds.toString());
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
