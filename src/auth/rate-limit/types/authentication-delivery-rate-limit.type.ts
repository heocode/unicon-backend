import type { GcraMultiAdmissionResult } from '../../../rate-limit/types/gcra-admission.type';

/** Internal caller supplies authoritative identity, never a resend recipient override. */
export type AuthenticationDeliveryRateLimitInput = Readonly<{
  challengeId: string;
  normalizedIdentity: string;
  ipAddress: string | undefined;
}>;

/** Provisional until the caller commits its new-Delivery admission transaction. */
export type AuthenticationDeliveryRateLimitResult =
  | Extract<GcraMultiAdmissionResult, { allowed: true }>
  | (Extract<GcraMultiAdmissionResult, { allowed: false }> & {
      retryNotBeforeMicros: bigint;
    });

export type AuthenticationDeliveryAdmissionWindow = Readonly<{
  expiresAtMicros: bigint;
  minValidityRemainingSeconds: number;
}>;

export type AuthenticationDeliveryWindowDenial = Readonly<{
  allowed: false;
  operationNowMicros: bigint;
  windowOutcome: 'CHALLENGE_UNAVAILABLE' | 'DELIVERY_WINDOW_CLOSED';
}>;

export type AuthenticationDeliveryCooldownAlias = Readonly<{
  key: string;
  count: number;
  windowEndAtMicros: string | null;
}>;
