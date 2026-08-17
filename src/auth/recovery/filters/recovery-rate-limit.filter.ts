import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { RecoveryRateLimitError } from '../errors/recovery-rate-limit.error';

@Catch(RecoveryRateLimitError)
export class RecoveryRateLimitFilter implements ExceptionFilter {
  catch(exception: RecoveryRateLimitError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    response.setHeader('Retry-After', exception.retryAfterSeconds.toString());
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
