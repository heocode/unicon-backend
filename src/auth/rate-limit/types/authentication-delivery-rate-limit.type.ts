import type { GcraMultiAdmissionResult } from '../../../rate-limit/types/gcra-admission.type';

/** Internal caller supplies authoritative identity, never a resend recipient override. */
export type AuthenticationDeliveryRateLimitInput = Readonly<{
  challengeId: string;
  normalizedIdentity: string;
  ipAddress: string | undefined;
}>;

/** Provisional until the caller commits its new-Delivery admission transaction. */
export type AuthenticationDeliveryRateLimitResult = GcraMultiAdmissionResult;

export type AuthenticationDeliveryCooldownAlias = Readonly<{
  key: string;
  count: number;
  windowEndAtMicros: string | null;
}>;
