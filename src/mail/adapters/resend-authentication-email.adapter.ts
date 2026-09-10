// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal ports
import { AuthenticationEmailProviderPort } from '../../auth/delivery/ports/authentication-email-provider.port';

// Internal services
import { ResendAuthenticationEmailTransportService } from '../services/resend-authentication-email-transport.service';

// Internal types
import {
  AuthenticationEmailPermanentFailureReason,
  type AuthenticationEmailProviderResult,
  AuthenticationEmailRetryKind,
  type AuthenticationEmailSubmission,
} from '../../auth/delivery/types/authentication-email-provider.type';
import type { ResendAuthenticationEmailTransportResponse } from '../services/resend-authentication-email-transport.service';

// Internal utilities
import { parseRetryAfterSeconds } from '../utils/parse-retry-after.util';

const RESEND_AUTHENTICATION_ERROR_NAMES = new Set([
  'missing_api_key',
  'restricted_api_key',
  'invalid_api_key',
  'invalid_access',
  'security_error',
]);

const RESEND_CONFIGURATION_ERROR_NAMES = new Set([
  'invalid_from_address',
  'invalid_region',
  'monthly_quota_exceeded',
  'daily_quota_exceeded',
]);

const RESEND_INVALID_REQUEST_ERROR_NAMES = new Set([
  'invalid_idempotency_key',
  'validation_error',
  'not_found',
  'method_not_allowed',
  'invalid_idempotent_request',
  'invalid_attachment',
  'invalid_parameter',
  'missing_required_field',
]);

@Injectable()
export class ResendAuthenticationEmailAdapter extends AuthenticationEmailProviderPort {
  private readonly httpTimeoutMilliseconds: number;
  private readonly authenticationEmailFrom: string;

  constructor(
    private readonly transport: ResendAuthenticationEmailTransportService,
    configService: ConfigService,
  ) {
    super();
    this.httpTimeoutMilliseconds =
      configService.getOrThrow<number>('AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS') *
      1_000;
    this.authenticationEmailFrom =
      configService.getOrThrow<string>('AUTH_EMAIL_FROM');
  }

  async submit(
    submission: AuthenticationEmailSubmission,
  ): Promise<AuthenticationEmailProviderResult> {
    if (submission.content.from !== this.authenticationEmailFrom) {
      return this.permanentFailure(
        AuthenticationEmailPermanentFailureReason.CONFIGURATION,
        'AUTHENTICATION_EMAIL_SENDER_MISMATCH',
      );
    }

    const operationNow = new Date();
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.httpTimeoutMilliseconds,
    );

    let response: ResendAuthenticationEmailTransportResponse;

    try {
      response = await this.transport.send(submission, abortController.signal);
    } catch {
      return {
        outcome: 'RETRYABLE',
        retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
        safeFailureCode: abortController.signal.aborted
          ? 'RESEND_HTTP_TIMEOUT'
          : 'RESEND_TRANSPORT_OUTCOME_UNKNOWN',
      };
    } finally {
      clearTimeout(timeout);
    }

    if (response.outcome === 'ACCEPTED') {
      return {
        outcome: 'ACCEPTED',
        ...(response.providerMessageId
          ? { providerMessageId: response.providerMessageId }
          : {}),
      };
    }

    return this.classifyRejection(response, operationNow);
  }

  private classifyRejection(
    response: Extract<
      ResendAuthenticationEmailTransportResponse,
      { outcome: 'REJECTED' }
    >,
    operationNow: Date,
  ): AuthenticationEmailProviderResult {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers,
      operationNow,
    );

    if (
      response.statusCode === 429 ||
      response.errorName === 'rate_limit_exceeded'
    ) {
      return {
        outcome: 'RETRYABLE',
        retryKind: AuthenticationEmailRetryKind.SAFE_RETRY,
        safeFailureCode: 'RESEND_RATE_LIMITED',
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }

    if (
      response.statusCode === 401 ||
      response.statusCode === 403 ||
      (response.errorName !== undefined &&
        RESEND_AUTHENTICATION_ERROR_NAMES.has(response.errorName))
    ) {
      return this.permanentFailure(
        AuthenticationEmailPermanentFailureReason.PROVIDER_AUTHENTICATION,
        'RESEND_AUTHENTICATION_REJECTED',
      );
    }

    if (
      response.errorName !== undefined &&
      RESEND_CONFIGURATION_ERROR_NAMES.has(response.errorName)
    ) {
      return this.permanentFailure(
        AuthenticationEmailPermanentFailureReason.CONFIGURATION,
        'RESEND_CONFIGURATION_REJECTED',
      );
    }

    if (
      response.errorName !== undefined &&
      RESEND_INVALID_REQUEST_ERROR_NAMES.has(response.errorName)
    ) {
      return this.permanentFailure(
        AuthenticationEmailPermanentFailureReason.INVALID_REQUEST,
        'RESEND_REQUEST_REJECTED',
      );
    }

    if (response.errorName === 'concurrent_idempotent_requests') {
      return this.ambiguousRetry(
        'RESEND_IDEMPOTENT_REQUEST_IN_PROGRESS',
        retryAfterSeconds,
      );
    }

    return this.ambiguousRetry(
      response.statusCode >= 500
        ? 'RESEND_SERVER_OUTCOME_UNKNOWN'
        : 'RESEND_OUTCOME_UNKNOWN',
      retryAfterSeconds,
    );
  }

  private ambiguousRetry(safeFailureCode: string, retryAfterSeconds?: number) {
    return {
      outcome: 'RETRYABLE' as const,
      retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
      safeFailureCode,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }

  private permanentFailure(
    reason: AuthenticationEmailPermanentFailureReason,
    safeFailureCode: string,
  ) {
    return {
      outcome: 'PERMANENT_FAILURE' as const,
      reason,
      safeFailureCode,
    };
  }
}
