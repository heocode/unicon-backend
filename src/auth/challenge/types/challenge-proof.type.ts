import type { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

export const ChallengeProofMethod = {
  OTP: 'OTP',
  MAGIC_LINK: 'MAGIC_LINK',
} as const;

export type ChallengeProofMethod =
  (typeof ChallengeProofMethod)[keyof typeof ChallengeProofMethod];

export type ChallengeProofContext = {
  challengeId: string;
  purpose: AuthenticationChallengePurpose;
  normalizedIdentity: string;
};

export type HashedChallengeProof = {
  hash: Buffer;
  hashProtocolVersion: number;
  hashKeyVersion: number;
};
