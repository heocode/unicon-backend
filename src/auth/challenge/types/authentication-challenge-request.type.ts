import type { CreatedAuthenticationDelivery } from '../../delivery/types/authentication-delivery.type';

/** Internal SIGN_IN input after institutional-email eligibility validation. */
export type AuthenticationSignInRequestInput = Readonly<{
  normalizedIdentity: string;
  ipAddress: string | undefined;
  idempotencyKey: string;
  templateProtocolVersion: number;
}>;

export type AuthenticationSignInRequestResult =
  | { outcome: 'REUSED'; challenge: { id: string; expiresAt: Date } }
  | {
      outcome: 'CREATED';
      challenge: { id: string; expiresAt: Date };
      delivery: CreatedAuthenticationDelivery;
      operationNowMicros: bigint;
    }
  | { outcome: 'CHALLENGE_UNAVAILABLE' | 'DELIVERY_WINDOW_CLOSED' }
  | {
      outcome: 'RATE_LIMITED';
      retryAfterSeconds: bigint;
      deniedPolicyIds: readonly string[];
    };
