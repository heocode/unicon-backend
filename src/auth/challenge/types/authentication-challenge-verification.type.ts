import type {
  AuthenticationChallengePurpose,
  AuthenticationMethod,
} from '../../../generated/prisma/enums';

export const ChallengeVerificationStatus = {
  VERIFIED: 'VERIFIED',
  INVALID_PROOF: 'INVALID_PROOF',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export const InvalidChallengeProofKind = {
  MALFORMED: 'MALFORMED',
  MISMATCH: 'MISMATCH',
} as const;

export const InternalChallengeUnavailabilityReason = {
  NOT_FOUND: 'NOT_FOUND',
  PURPOSE_MISMATCH: 'PURPOSE_MISMATCH',
  CONSUMED: 'CONSUMED',
  LOCKED: 'LOCKED',
  EXPIRED: 'EXPIRED',
} as const;

export type InvalidChallengeProofKind =
  (typeof InvalidChallengeProofKind)[keyof typeof InvalidChallengeProofKind];

export type InternalChallengeUnavailabilityReason =
  (typeof InternalChallengeUnavailabilityReason)[keyof typeof InternalChallengeUnavailabilityReason];

export type AuthenticationChallengeVerificationInput = {
  challengeId: string;
  expectedPurpose: AuthenticationChallengePurpose;
  proof: string;
};

export type VerifiedAuthenticationChallenge = {
  id: string;
  normalizedIdentity: string;
  purpose: AuthenticationChallengePurpose;
  userId: string | null;
  boundSessionId: string | null;
  authenticationMethod: AuthenticationMethod;
  authenticatedAt: Date;
  consumedAt: Date;
};

export type InvalidChallengeProofResult = {
  status: typeof ChallengeVerificationStatus.INVALID_PROOF;
  kind: InvalidChallengeProofKind;
  attemptConsumed: boolean;
  failedAttemptCount: number;
  attemptsRemaining: number;
  locked: boolean;
  lockedAt: Date | null;
};

export type ChallengeUnavailableResult = {
  status: typeof ChallengeVerificationStatus.UNAVAILABLE;
  internalReason: InternalChallengeUnavailabilityReason;
};

export type ChallengeVerifiedResult = {
  status: typeof ChallengeVerificationStatus.VERIFIED;
  challenge: VerifiedAuthenticationChallenge;
};

export type AuthenticationChallengeVerificationResult =
  | InvalidChallengeProofResult
  | ChallengeUnavailableResult
  | ChallengeVerifiedResult;
