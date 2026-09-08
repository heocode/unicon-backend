import { ConfigService } from '@nestjs/config';

import { AuthenticationDeliveryPolicyService } from './authentication-delivery-policy.service';

describe('AuthenticationDeliveryPolicyService', () => {
  const values: Record<string, number | number[]> = {
    AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS: 5,
    AUTH_DELIVERY_RETRY_BACKOFF_SECONDS: [5, 15, 30, 60],
    AUTH_DELIVERY_RETRY_JITTER_PERCENT: 20,
    AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS: 10,
    AUTH_DELIVERY_PROCESSING_LEASE_SECONDS: 45,
    AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS: 120,
    AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS: 86_400,
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => values[key]),
  };

  it.each([
    [1, 5],
    [2, 15],
    [3, 30],
    [4, 60],
    [5, null],
  ])(
    'maps completed processing attempt %i to retry delay %s',
    (completedAttemptCount, expectedDelaySeconds) => {
      const service = new AuthenticationDeliveryPolicyService(
        configService as unknown as ConfigService,
      );

      expect(service.getRetryDelaySeconds(completedAttemptCount)).toBe(
        expectedDelaySeconds,
      );
    },
  );

  it.each([0, 6, 1.5])('rejects invalid attempt count %s', (attemptCount) => {
    const service = new AuthenticationDeliveryPolicyService(
      configService as unknown as ConfigService,
    );

    expect(() => service.getRetryDelaySeconds(attemptCount)).toThrow(
      'Delivery processing attempt count is outside policy.',
    );
  });
});
