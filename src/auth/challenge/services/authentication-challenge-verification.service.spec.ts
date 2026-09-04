import type { Prisma } from '../../../generated/prisma/client';
import {
  AuthenticationChallengePurpose,
  AuthenticationMethod,
} from '../../../generated/prisma/enums';

import type { LockedAuthenticationChallenge } from '../repositories/authentication-challenge.repository';
import {
  ChallengeVerificationStatus,
  InternalChallengeUnavailabilityReason,
  InvalidChallengeProofKind,
} from '../types/authentication-challenge-verification.type';
import { AuthenticationChallengeVerificationService } from './authentication-challenge-verification.service';

describe('AuthenticationChallengeVerificationService', () => {
  const operationNow = new Date('2026-09-04T12:00:00.000Z');
  const canonicalOtp = '004201';
  const canonicalLinkToken = Buffer.alloc(32, 1).toString('base64url');
  const challenge: LockedAuthenticationChallenge = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    normalizedIdentity: 'student@example.edu',
    purpose: AuthenticationChallengePurpose.SIGN_IN,
    userId: null,
    boundSessionId: null,
    otpHash: Buffer.alloc(32, 2),
    linkTokenHash: Buffer.alloc(32, 3),
    hashProtocolVersion: 1,
    hashKeyVersion: 1,
    expiresAt: new Date('2026-09-04T12:10:00.000Z'),
    failedAttemptCount: 0,
    maxAttempts: 5,
    consumedAt: null,
    lockedAt: null,
  };

  let repository: {
    lockByIdForUpdate: jest.Mock;
    getOperationTimestamp: jest.Mock;
    enforceAttemptLimitLock: jest.Mock;
    clearExpiredEnvelope: jest.Mock;
    recordOtpFailure: jest.Mock;
    consume: jest.Mock;
  };
  let proofService: {
    verifyOtp: jest.Mock;
    verifyMagicLinkToken: jest.Mock;
  };
  let service: AuthenticationChallengeVerificationService;
  const transaction = {} as Prisma.TransactionClient;

  beforeEach(() => {
    repository = {
      lockByIdForUpdate: jest.fn().mockResolvedValue(challenge),
      getOperationTimestamp: jest.fn().mockResolvedValue(operationNow),
      enforceAttemptLimitLock: jest.fn().mockResolvedValue(undefined),
      clearExpiredEnvelope: jest.fn().mockResolvedValue(undefined),
      recordOtpFailure: jest.fn(),
      consume: jest.fn().mockResolvedValue(undefined),
    };
    proofService = {
      verifyOtp: jest.fn(),
      verifyMagicLinkToken: jest.fn(),
    };
    service = new AuthenticationChallengeVerificationService(
      repository,
      proofService,
    );
  });

  it('gets one operation timestamp after acquiring the row lock', async () => {
    proofService.verifyOtp.mockReturnValue(true);

    await service.verifyAndConsumeOtpInTransaction(transaction, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      proof: canonicalOtp,
    });

    expect(repository.getOperationTimestamp).toHaveBeenCalledTimes(1);
    expect(
      repository.lockByIdForUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(
      repository.getOperationTimestamp.mock.invocationCallOrder[0],
    );
    expect(repository.consume).toHaveBeenCalledWith(
      transaction,
      challenge.id,
      operationNow,
    );
  });

  it('does not consume an OTP attempt for malformed proof', async () => {
    const result = await service.verifyAndConsumeOtpInTransaction(transaction, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      proof: '4201',
    });

    expect(result).toMatchObject({
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind: InvalidChallengeProofKind.MALFORMED,
      attemptConsumed: false,
      failedAttemptCount: 0,
      attemptsRemaining: 5,
    });
    expect(proofService.verifyOtp).not.toHaveBeenCalled();
    expect(repository.recordOtpFailure).not.toHaveBeenCalled();
  });

  it('uses the atomic returned state for a canonical wrong OTP', async () => {
    proofService.verifyOtp.mockReturnValue(false);
    repository.recordOtpFailure.mockResolvedValue({
      failedAttemptCount: 5,
      maxAttempts: 5,
      lockedAt: operationNow,
    });

    const result = await service.verifyAndConsumeOtpInTransaction(transaction, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      proof: canonicalOtp,
    });

    expect(result).toEqual({
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind: InvalidChallengeProofKind.MISMATCH,
      attemptConsumed: true,
      failedAttemptCount: 5,
      attemptsRemaining: 0,
      locked: true,
      lockedAt: operationNow,
    });
  });

  it('self-heals an exhausted challenge fail-closed', async () => {
    repository.lockByIdForUpdate.mockResolvedValue({
      ...challenge,
      failedAttemptCount: 5,
    });

    const result = await service.verifyAndConsumeOtpInTransaction(transaction, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      proof: canonicalOtp,
    });

    expect(repository.enforceAttemptLimitLock).toHaveBeenCalledWith(
      transaction,
      challenge.id,
      operationNow,
    );
    expect(result).toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.LOCKED,
    });
    expect(proofService.verifyOtp).not.toHaveBeenCalled();
  });

  it('clears an envelope when expiry equals operation time', async () => {
    repository.lockByIdForUpdate.mockResolvedValue({
      ...challenge,
      expiresAt: operationNow,
    });

    const result = await service.verifyAndConsumeOtpInTransaction(transaction, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      proof: canonicalOtp,
    });

    expect(repository.clearExpiredEnvelope).toHaveBeenCalledWith(
      transaction,
      challenge.id,
      operationNow,
    );
    expect(result).toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.EXPIRED,
    });
  });

  it('returns a verified OTP result with the shared operation timestamp', async () => {
    proofService.verifyOtp.mockReturnValue(true);

    const result = await service.verifyAndConsumeOtpInTransaction(transaction, {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      proof: canonicalOtp,
    });

    expect(result).toEqual({
      status: ChallengeVerificationStatus.VERIFIED,
      challenge: {
        id: challenge.id,
        normalizedIdentity: challenge.normalizedIdentity,
        purpose: challenge.purpose,
        userId: null,
        boundSessionId: null,
        authenticationMethod: AuthenticationMethod.EMAIL_OTP,
        authenticatedAt: operationNow,
        consumedAt: operationNow,
      },
    });
  });

  it('does not mutate challenge state for a wrong canonical magic link', async () => {
    proofService.verifyMagicLinkToken.mockReturnValue(false);

    const result = await service.verifyAndConsumeMagicLinkInTransaction(
      transaction,
      {
        challengeId: challenge.id,
        expectedPurpose: challenge.purpose,
        proof: canonicalLinkToken,
      },
    );

    expect(result).toMatchObject({
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind: InvalidChallengeProofKind.MISMATCH,
      attemptConsumed: false,
    });
    expect(repository.recordOtpFailure).not.toHaveBeenCalled();
    expect(repository.consume).not.toHaveBeenCalled();
  });

  it('does not mutate challenge state for a malformed magic link', async () => {
    const result = await service.verifyAndConsumeMagicLinkInTransaction(
      transaction,
      {
        challengeId: challenge.id,
        expectedPurpose: challenge.purpose,
        proof: `${canonicalLinkToken}=`,
      },
    );

    expect(result).toMatchObject({
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind: InvalidChallengeProofKind.MALFORMED,
      attemptConsumed: false,
    });
    expect(proofService.verifyMagicLinkToken).not.toHaveBeenCalled();
    expect(repository.recordOtpFailure).not.toHaveBeenCalled();
    expect(repository.consume).not.toHaveBeenCalled();
  });

  it('keeps a purpose mismatch internal and does not mutate state', async () => {
    const result = await service.verifyAndConsumeOtpInTransaction(transaction, {
      challengeId: challenge.id,
      expectedPurpose: AuthenticationChallengePurpose.STEP_UP,
      proof: canonicalOtp,
    });

    expect(result).toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.PURPOSE_MISMATCH,
    });
    expect(proofService.verifyOtp).not.toHaveBeenCalled();
    expect(repository.consume).not.toHaveBeenCalled();
  });

  it.each([
    [null, InternalChallengeUnavailabilityReason.NOT_FOUND],
    [
      { ...challenge, consumedAt: operationNow },
      InternalChallengeUnavailabilityReason.CONSUMED,
    ],
    [
      { ...challenge, lockedAt: operationNow },
      InternalChallengeUnavailabilityReason.LOCKED,
    ],
  ])(
    'returns an internal unavailable result without checking proof',
    async (row, reason) => {
      repository.lockByIdForUpdate.mockResolvedValue(row);

      const result = await service.verifyAndConsumeOtpInTransaction(
        transaction,
        {
          challengeId: challenge.id,
          expectedPurpose: challenge.purpose,
          proof: canonicalOtp,
        },
      );

      expect(result).toEqual({
        status: ChallengeVerificationStatus.UNAVAILABLE,
        internalReason: reason,
      });
      expect(proofService.verifyOtp).not.toHaveBeenCalled();
    },
  );
});
