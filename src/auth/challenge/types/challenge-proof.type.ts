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

export type TransientChallengeDeliveryProof = {
  otp: string;
  linkToken: string;
};

export type HashedChallengeProofData = {
  otpHash: Buffer;
  linkTokenHash: Buffer;
  hashProtocolVersion: number;
  hashKeyVersion: number;
};

export type EncryptedChallengeProofData = {
  encryptedProof: Uint8Array;
  proofEncryptionIv: Uint8Array;
  proofEncryptionTag: Uint8Array;
  encryptionProtocolVersion: number;
  encryptionKeyVersion: number;
};

export type ChallengeProofPersistenceData = {
  hashing: HashedChallengeProofData;
  encryption: EncryptedChallengeProofData;
};

export type GeneratedChallengeProof = {
  persistence: ChallengeProofPersistenceData;
  deliveryProof: TransientChallengeDeliveryProof;
};
