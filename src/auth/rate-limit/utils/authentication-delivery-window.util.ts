import type { AuthenticationDeliveryAdmissionWindow } from '../types/authentication-delivery-rate-limit.type';

/** Shared lifecycle/window decision after each newly introduced serialization wait. */
export function authenticationDeliveryWindowOutcome(
  window: AuthenticationDeliveryAdmissionWindow,
  nowMicros: bigint,
): 'CHALLENGE_UNAVAILABLE' | 'DELIVERY_WINDOW_CLOSED' | null {
  const remaining = window.expiresAtMicros - nowMicros;
  if (remaining <= 0n) return 'CHALLENGE_UNAVAILABLE';
  if (remaining < BigInt(window.minValidityRemainingSeconds) * 1_000_000n)
    return 'DELIVERY_WINDOW_CLOSED';
  return null;
}
