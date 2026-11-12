import type { CreatedAuthenticationDelivery } from './authentication-delivery.type';

export type AuthenticationResendAdmissionInput = Readonly<{
  challengeId: string;
  ipAddress: string | undefined;
  idempotencyKey: string;
  templateProtocolVersion: number;
  retentionExpiresAt: Date;
}>;

export type AuthenticationInitialAdmissionInput =
  AuthenticationResendAdmissionInput;

/** Internal result; provisional until the caller commits. No public HTTP mapping. */
export type AuthenticationResendAdmissionResult =
  | {
      outcome: 'CREATED';
      delivery: CreatedAuthenticationDelivery;
      operationNowMicros: bigint;
    }
  | { outcome: 'EXISTING'; delivery: CreatedAuthenticationDelivery }
  | {
      outcome:
        | 'CHALLENGE_UNAVAILABLE'
        | 'DELIVERY_WINDOW_CLOSED'
        | 'DELIVERY_CAPACITY_UNAVAILABLE';
    }
  | {
      outcome: 'RATE_LIMITED' | 'GLOBAL_RATE_DENIED';
      operationNowMicros: bigint;
      retryNotBeforeMicros: bigint;
      retryAfterSeconds: bigint;
      deniedPolicyIds: readonly string[];
    };

export type AuthenticationInitialAdmissionResult = Exclude<
  AuthenticationResendAdmissionResult,
  { outcome: 'EXISTING' }
>;
