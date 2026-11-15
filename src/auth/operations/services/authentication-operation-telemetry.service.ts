import { Injectable, Logger } from '@nestjs/common';

import { AUTHENTICATION_GLOBAL_DELIVERY_ADMISSION as globalAdmission } from '../../rate-limit/constants/authentication-global-delivery-admission.constants';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../../rate-limit/constants/authentication-rate-limit-policies.constants';
import type {
  AuthenticationOperationTelemetryEvent,
  AuthenticationOperationTelemetryInput,
} from '../types/authentication-operation-telemetry.type';

const policyIds = new Set<string>([
  globalAdmission.policyId,
  policies.deliveryIdentity.id,
  policies.deliveryIp.id,
  policies.identityDeliveryCooldown.id,
  policies.challengeDeliveryCooldown.id,
]);
const outcomes = new Set([
  'CREATED',
  'REUSED',
  'EXISTING',
  'DENIED',
  'FAILURE',
]);
const denials = new Set([
  'RATE_LIMITED',
  'GLOBAL_RATE_DENIED',
  'CHALLENGE_UNAVAILABLE',
  'DELIVERY_WINDOW_CLOSED',
  'DELIVERY_CAPACITY_UNAVAILABLE',
]);
const failures = new Set([
  'INVALID_INPUT',
  'INVALID_STATE',
  'OPERATION_CONFLICT',
  'OPERATION_EXPIRED',
  'STATE_UNAVAILABLE',
  'RETRY_EXHAUSTED',
  'COMMIT_OUTCOME_UNKNOWN',
  'NOT_COMMITTED',
  'UNEXPECTED',
]);

@Injectable()
export class AuthenticationOperationTelemetryService {
  private readonly logger = new Logger(
    AuthenticationOperationTelemetryService.name,
  );

  record(input: AuthenticationOperationTelemetryInput): void | Promise<void> {
    const outcome = outcomes.has(input.outcome) ? input.outcome : 'FAILURE';
    const event: AuthenticationOperationTelemetryEvent = {
      event: 'AUTHENTICATION_OPERATION_COMPLETED',
      schemaVersion: 1,
      operation:
        input.operation === 'SIGN_IN_REQUEST' || input.operation === 'RESEND'
          ? input.operation
          : 'UNKNOWN',
      outcome,
      replayed: input.replayed === true,
      durationMs:
        Number.isFinite(input.durationMs) && input.durationMs >= 0
          ? input.durationMs
          : 0,
      denial:
        outcome === 'DENIED' && input.denial && denials.has(input.denial)
          ? input.denial
          : null,
      deniedPolicyIds:
        outcome === 'DENIED' && Array.isArray(input.deniedPolicyIds)
          ? [
              ...new Set(
                input.deniedPolicyIds.filter(
                  (id: unknown): id is string =>
                    typeof id === 'string' && policyIds.has(id),
                ),
              ),
            ].sort()
          : [],
      failureReason:
        outcome === 'FAILURE' &&
        input.failureReason &&
        failures.has(input.failureReason)
          ? input.failureReason
          : outcome === 'FAILURE'
            ? 'UNEXPECTED'
            : null,
    };
    return this.publish(event);
  }

  // The caller owns failure isolation. Receivers must not block synchronously.
  protected publish(
    event: AuthenticationOperationTelemetryEvent,
  ): void | Promise<void> {
    this.logger.log(JSON.stringify(event));
  }
}
