import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GcraAdmissionConfigService {
  readonly maxAttempts: number;
  readonly timeoutSeconds: number;
  readonly maxWaitSeconds: number;

  constructor(config: ConfigService) {
    this.maxAttempts = config.getOrThrow<number>(
      'RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS',
    );
    this.timeoutSeconds = config.getOrThrow<number>(
      'RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS',
    );
    this.maxWaitSeconds = config.getOrThrow<number>(
      'RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS',
    );
  }
}
