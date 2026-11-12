/** Internal authoritative context from a locked, correctly bound challenge. */
export type AuthenticationVerificationRateLimitInput = Readonly<{
  normalizedIdentity: string;
  ipAddress: string | undefined;
  expiresAtMicros: bigint;
}>;

export const AuthenticationVerificationProofOutcome = {
  MATCH: 'MATCH',
  CANONICAL_MISMATCH: 'CANONICAL_MISMATCH',
  EXCLUDED: 'EXCLUDED',
} as const;

export type AuthenticationVerificationProofOutcome =
  (typeof AuthenticationVerificationProofOutcome)[keyof typeof AuthenticationVerificationProofOutcome];

/** No proof or client-selected charging flag crosses this limiter boundary. */
export type AuthenticationVerificationProofCheck = (
  operationNowMicros: bigint,
) => Promise<AuthenticationVerificationProofOutcome>;

/** All results are provisional until the surrounding owner commits. */
export type AuthenticationVerificationRateLimitResult =
  | Readonly<{
      outcome: AuthenticationVerificationProofOutcome | 'EXPIRED';
      operationNowMicros: bigint;
    }>
  | Readonly<{
      outcome: 'RATE_LIMITED';
      operationNowMicros: bigint;
      retryAfterSeconds: bigint;
      retryNotBeforeMicros: bigint;
      deniedPolicyIds: readonly string[];
    }>;
