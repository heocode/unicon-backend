import { ConfigService } from '@nestjs/config';

import {
  AuthenticationEmailPermanentFailureReason,
  AuthenticationEmailRetryKind,
  type AuthenticationEmailSubmission,
} from '../../auth/delivery/types/authentication-email-provider.type';
import { ResendMailTransportService } from '../services/resend-mail-transport.service';
import { ResendAuthenticationEmailAdapter } from './resend-authentication-email.adapter';

describe('ResendAuthenticationEmailAdapter', () => {
  const submission: AuthenticationEmailSubmission = Object.freeze({
    content: Object.freeze({
      recipient: 'student@example.edu',
      from: 'Unicon <noreply@uniconnection.app>',
      subject: '482731 — Your Unicon sign-in code',
      html: '<p>immutable html</p>',
      text: 'immutable text',
    }),
    deliveryId: '123e4567-e89b-42d3-a456-426614174000',
    idempotencyKey: 'delivery-idempotency-key',
    templateProtocolVersion: 1,
  });
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string | number> = {
        AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS: 10,
        AUTH_EMAIL_FROM: 'Unicon <noreply@uniconnection.app>',
      };

      return values[key];
    }),
  };
  const transport = { send: jest.fn() };
  const authorize = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);

  let adapter: ResendAuthenticationEmailAdapter;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    jest.clearAllMocks();
    adapter = new ResendAuthenticationEmailAdapter(
      transport as unknown as ResendMailTransportService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [
      { providerMessageId: 'email-id' },
      { outcome: 'ACCEPTED', providerMessageId: 'email-id' },
    ],
    [{}, { outcome: 'ACCEPTED' }],
  ])(
    'accepts a provider response with optional message ID',
    async (provider, expected) => {
      transport.send.mockResolvedValue({
        outcome: 'ACCEPTED',
        ...provider,
        headers: {},
      });

      await expect(adapter.submit(submission, authorize)).resolves.toEqual(
        expected,
      );
    },
  );

  it('returns SAFE_RETRY only for an explicit rate-limit rejection', async () => {
    transport.send.mockResolvedValue({
      outcome: 'REJECTED',
      errorName: 'rate_limit_exceeded',
      statusCode: 429,
      headers: { 'retry-after': '45' },
    });

    await expect(adapter.submit(submission, authorize)).resolves.toEqual({
      outcome: 'RETRYABLE',
      retryKind: AuthenticationEmailRetryKind.SAFE_RETRY,
      safeFailureCode: 'RESEND_RATE_LIMITED',
      retryAfterSeconds: 45,
    });
  });

  it.each([
    ['internal_server_error', 500, 'RESEND_SERVER_OUTCOME_UNKNOWN'],
    ['application_error', 503, 'RESEND_SERVER_OUTCOME_UNKNOWN'],
    [
      'concurrent_idempotent_requests',
      409,
      'RESEND_IDEMPOTENT_REQUEST_IN_PROGRESS',
    ],
    ['unknown_error', 400, 'RESEND_OUTCOME_UNKNOWN'],
  ])(
    'classifies %s/%i as AMBIGUOUS_RETRY',
    async (errorName, statusCode, safeFailureCode) => {
      transport.send.mockResolvedValue({
        outcome: 'REJECTED',
        errorName,
        statusCode,
        headers: {},
      });

      await expect(adapter.submit(submission, authorize)).resolves.toEqual({
        outcome: 'RETRYABLE',
        retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
        safeFailureCode,
      });
    },
  );

  it('preserves Retry-After on an ambiguous HTTP response', async () => {
    transport.send.mockResolvedValue({
      outcome: 'REJECTED',
      errorName: 'internal_server_error',
      statusCode: 503,
      headers: { 'retry-after': '60' },
    });

    await expect(adapter.submit(submission, authorize)).resolves.toEqual({
      outcome: 'RETRYABLE',
      retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
      safeFailureCode: 'RESEND_SERVER_OUTCOME_UNKNOWN',
      retryAfterSeconds: 60,
    });
  });

  it.each([
    [
      'invalid_api_key',
      401,
      AuthenticationEmailPermanentFailureReason.PROVIDER_AUTHENTICATION,
      'RESEND_AUTHENTICATION_REJECTED',
    ],
    [
      'invalid_from_address',
      422,
      AuthenticationEmailPermanentFailureReason.CONFIGURATION,
      'RESEND_CONFIGURATION_REJECTED',
    ],
    [
      'validation_error',
      422,
      AuthenticationEmailPermanentFailureReason.INVALID_REQUEST,
      'RESEND_REQUEST_REJECTED',
    ],
  ])(
    'normalizes permanent provider failure %s',
    async (errorName, statusCode, reason, safeFailureCode) => {
      transport.send.mockResolvedValue({
        outcome: 'REJECTED',
        errorName,
        statusCode,
        headers: {},
      });

      await expect(adapter.submit(submission, authorize)).resolves.toEqual({
        outcome: 'PERMANENT_FAILURE',
        reason,
        safeFailureCode,
      });
    },
  );

  it('classifies a failure before authorization as technical unavailability', async () => {
    transport.send.mockRejectedValue(new Error('raw provider secret'));

    await expect(adapter.submit(submission, authorize)).resolves.toEqual({
      outcome: 'UNAVAILABLE',
    });
  });

  it('aborts waiting after exactly ten seconds and returns an ambiguous outcome', async () => {
    transport.send.mockImplementation(
      async (
        _submission: AuthenticationEmailSubmission,
        signal: AbortSignal,
        before: () => Promise<boolean>,
      ) => {
        await before();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );
    const result = adapter.submit(submission, authorize);

    await jest.advanceTimersByTimeAsync(9_999);
    expect(transport.send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      outcome: 'RETRYABLE',
      retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
      safeFailureCode: 'RESEND_HTTP_TIMEOUT',
    });
  });

  it('reuses the same operational context without mutating immutable content', async () => {
    transport.send.mockResolvedValue({
      outcome: 'ACCEPTED',
      headers: {},
    });

    await adapter.submit(submission, authorize);
    await adapter.submit(submission, authorize);

    expect(transport.send).toHaveBeenNthCalledWith(
      1,
      submission,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(transport.send).toHaveBeenNthCalledWith(
      2,
      submission,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(submission.idempotencyKey).toBe('delivery-idempotency-key');
    expect(submission.content.html).toBe('<p>immutable html</p>');
  });

  it('rejects a sender mismatch without calling the provider', async () => {
    await expect(
      adapter.submit(
        {
          ...submission,
          content: { ...submission.content, from: 'attacker@example.com' },
        },
        authorize,
      ),
    ).resolves.toEqual({
      outcome: 'PERMANENT_FAILURE',
      reason: AuthenticationEmailPermanentFailureReason.CONFIGURATION,
      safeFailureCode: 'AUTHENTICATION_EMAIL_SENDER_MISMATCH',
    });
    expect(transport.send).not.toHaveBeenCalled();
  });
  it.each(['DAILY_QUOTA', 'MONTHLY_QUOTA'] as const)(
    'keeps %s distinct from rate limiting',
    async (restriction) => {
      transport.send.mockResolvedValue({
        outcome: 'REJECTED',
        statusCode: 429,
        providerRestriction: restriction,
        pressurePersistence: 'RECORDED',
        headers: {},
      });
      expect(await adapter.submit(submission, authorize)).toEqual({
        outcome: 'RETRYABLE',
        retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
        safeFailureCode:
          restriction === 'DAILY_QUOTA'
            ? 'RESEND_DAILY_QUOTA_EXCEEDED'
            : 'RESEND_MONTHLY_QUOTA_EXCEEDED',
      });
    },
  );

  it('does not turn ACCEPTED into a retry after pressure persistence fails', async () => {
    transport.send.mockResolvedValue({
      outcome: 'ACCEPTED',
      providerMessageId: 'accepted-id',
      pressurePersistence: 'FAILED',
      headers: {},
    });
    expect(await adapter.submit(submission, authorize)).toEqual({
      outcome: 'ACCEPTED',
      providerMessageId: 'accepted-id',
    });
  });

  it('surfaces pressure persistence failure on rejection as a technical ambiguous retry', async () => {
    transport.send.mockResolvedValue({
      outcome: 'REJECTED',
      statusCode: 429,
      providerRestriction: 'RATE_LIMIT',
      pressurePersistence: 'FAILED',
      headers: { 'retry-after': '30' },
    });
    expect(await adapter.submit(submission, authorize)).toEqual({
      outcome: 'RETRYABLE',
      retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
      safeFailureCode: 'RESEND_PRESSURE_PERSISTENCE_FAILED',
      retryAfterSeconds: 30,
    });
  });
});
