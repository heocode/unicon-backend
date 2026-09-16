// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthenticationDeliveryPolicyService {
  readonly maxProcessingAttempts: number;
  readonly retryJitterPercent: number;
  readonly httpTimeoutSeconds: number;
  readonly processingLeaseSeconds: number;
  readonly minValidityRemainingSeconds: number;
  readonly providerIdempotencyWindowSeconds: number;
  readonly workerIntervalSeconds: number;
  readonly workerConcurrency: number;
  readonly workerMaxDeliveriesPerCycle: number;
  readonly workerExhaustedLeaseBatchSize: number;

  private readonly retryBackoffByCompletedAttempt: ReadonlyMap<number, number>;

  constructor(configService: ConfigService) {
    this.maxProcessingAttempts = configService.getOrThrow<number>(
      'AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS',
    );
    const retryBackoffSeconds = configService.getOrThrow<number[]>(
      'AUTH_DELIVERY_RETRY_BACKOFF_SECONDS',
    );
    this.retryBackoffByCompletedAttempt = new Map(
      retryBackoffSeconds.map((delaySeconds, index) => [
        index + 1,
        delaySeconds,
      ]),
    );
    this.retryJitterPercent = configService.getOrThrow<number>(
      'AUTH_DELIVERY_RETRY_JITTER_PERCENT',
    );
    this.httpTimeoutSeconds = configService.getOrThrow<number>(
      'AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS',
    );
    this.processingLeaseSeconds = configService.getOrThrow<number>(
      'AUTH_DELIVERY_PROCESSING_LEASE_SECONDS',
    );
    this.minValidityRemainingSeconds = configService.getOrThrow<number>(
      'AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS',
    );
    this.providerIdempotencyWindowSeconds = configService.getOrThrow<number>(
      'AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS',
    );
    this.workerIntervalSeconds = configService.getOrThrow<number>(
      'AUTH_DELIVERY_WORKER_INTERVAL_SECONDS',
    );
    this.workerConcurrency = configService.getOrThrow<number>(
      'AUTH_DELIVERY_WORKER_CONCURRENCY',
    );
    this.workerMaxDeliveriesPerCycle = configService.getOrThrow<number>(
      'AUTH_DELIVERY_WORKER_MAX_DELIVERIES_PER_CYCLE',
    );
    this.workerExhaustedLeaseBatchSize = configService.getOrThrow<number>(
      'AUTH_DELIVERY_WORKER_EXHAUSTED_LEASE_BATCH_SIZE',
    );
  }

  getRetryDelaySeconds(completedAttemptCount: number): number | null {
    if (
      !Number.isInteger(completedAttemptCount) ||
      completedAttemptCount < 1 ||
      completedAttemptCount > this.maxProcessingAttempts
    ) {
      throw new Error('Delivery processing attempt count is outside policy.');
    }

    return (
      this.retryBackoffByCompletedAttempt.get(completedAttemptCount) ?? null
    );
  }
}
